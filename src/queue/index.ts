/**
 * The job queue, on the `jobs` table.
 *
 * `FOR UPDATE SKIP LOCKED` gives exactly-once delivery among competing
 * consumers, the dedupe index makes an enqueue idempotent, and a job whose
 * consumer died is reclaimed after its lease runs out. Failed jobs retry with
 * backoff and are dead-lettered after `maxAttempts`.
 */
import { randomUUID } from 'node:crypto';
import { one, query, tx } from '../db/pool.js';
import { log } from '../log.js';

export type JobName =
  | 'compile'
  | 'eval'
  | 'classify_async'
  | 'webhook'
  | 'shadow'
  | 'retention'
  | 'drift_scan';

export interface EnqueueOptions {
  /** Milliseconds to wait before the job becomes runnable. */
  delayMs?: number;
  /** Suppresses a duplicate while an identical job is queued or running. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface JobContext {
  id: string;
  name: JobName;
  attempt: number;
  /** Jobs report progress so the UI can stream it. */
  progress(payload: Record<string, unknown>): Promise<void>;
}

export type JobHandler = (payload: any, ctx: JobContext) => Promise<unknown>;

const WORKER_ID = `${process.env.HOSTNAME ?? 'local'}-${randomUUID().slice(0, 8)}`;
const POLL_MS = 1000;
/** A job whose worker died is reclaimed after this long. */
const LEASE_MS = 15 * 60_000;

let running = false;
let timer: NodeJS.Timeout | null = null;

export async function enqueue(name: JobName, payload: unknown, opts: EnqueueOptions = {}): Promise<string> {
  const runAt = new Date(Date.now() + (opts.delayMs ?? 0));
  const row = await one<{ id: number }>(
    `INSERT INTO jobs (queue, payload, dedupe_key, run_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running')
     DO NOTHING
     RETURNING id`,
    [name, JSON.stringify(payload), opts.dedupeKey ?? null, runAt, opts.maxAttempts ?? 5],
  );
  if (!row) {
    // A job with the same dedupe key is already pending; return its id.
    const existing = await one<{ id: number }>(
      `SELECT id FROM jobs WHERE queue = $1 AND dedupe_key = $2 AND state IN ('queued','running') LIMIT 1`,
      [name, opts.dedupeKey],
    );
    return String(existing?.id ?? 0);
  }
  return String(row.id);
}

/** Starts draining the queue in this process. */
export async function consume(handlers: Partial<Record<JobName, JobHandler>>, concurrency: number): Promise<void> {
  running = true;
  const queues = Object.keys(handlers) as JobName[];
  let active = 0;

  const tick = async (): Promise<void> => {
    if (!running) return;
    try {
      await reclaimStuckJobs(queues);
      while (active < concurrency) {
        const job = await claim(queues);
        if (!job) break;
        active++;
        void runJob(job, handlers[job.queue as JobName]!)
          .finally(() => {
            active--;
          });
      }
    } catch (err) {
      log.warn('queue poll failed', { error: (err as Error).message });
    }
    if (running) {
      timer = setTimeout(() => void tick(), POLL_MS);
      timer.unref?.();
    }
  };

  log.info('queue consuming', { queues, concurrency, worker: WORKER_ID });
  await tick();
}

export async function closeQueue(): Promise<void> {
  running = false;
  if (timer) clearTimeout(timer);
}

interface ClaimedJob {
  id: number;
  queue: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

async function claim(queues: JobName[]): Promise<ClaimedJob | null> {
  return tx(async (client) => {
    const r = await client.query<ClaimedJob>(
      `WITH next AS (
         SELECT id FROM jobs
          WHERE state = 'queued' AND queue = ANY($1) AND run_at <= now()
          ORDER BY run_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE jobs j
          SET state = 'running', locked_at = now(), locked_by = $2, attempts = j.attempts + 1
         FROM next
        WHERE j.id = next.id
        RETURNING j.id, j.queue, j.payload, j.attempts, j.max_attempts`,
      [queues, WORKER_ID],
    );
    return r.rows[0] ?? null;
  });
}

/** A worker that died mid-job leaves a lease behind; this returns it to the queue. */
async function reclaimStuckJobs(queues: JobName[]): Promise<void> {
  const r = await query(
    `UPDATE jobs
        SET state = 'queued', locked_at = NULL, locked_by = NULL
      WHERE state = 'running' AND queue = ANY($1)
        AND locked_at < now() - ($2 || ' milliseconds')::interval
        AND attempts < max_attempts`,
    [queues, LEASE_MS],
  );
  if (r.rowCount) log.warn('reclaimed stalled jobs', { count: r.rowCount });
}

async function runJob(job: ClaimedJob, handler: JobHandler): Promise<void> {
  const started = Date.now();
  try {
    const result = await handler(job.payload, {
      id: String(job.id),
      name: job.queue as JobName,
      attempt: job.attempts,
      progress: async (payload) => {
        await query(`UPDATE jobs SET payload = payload || $2::jsonb WHERE id = $1`, [
          job.id,
          JSON.stringify({ _progress: payload }),
        ]);
      },
    });
    await query(
      `UPDATE jobs SET state = 'done', finished_at = now(), payload = payload || $2::jsonb WHERE id = $1`,
      [job.id, JSON.stringify({ _result: truncateResult(result) })],
    );
    log.info('job done', { queue: job.queue, id: job.id, duration_ms: Date.now() - started });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const dead = job.attempts >= job.max_attempts;
    await query(
      `UPDATE jobs
          SET state = $2, last_error = $3,
              run_at = now() + ($4 || ' milliseconds')::interval,
              finished_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END
        WHERE id = $1`,
      [job.id, dead ? 'dead' : 'queued', message.slice(0, 2000), backoffMs(job.attempts)],
    );
    log[dead ? 'error' : 'warn'](dead ? 'job dead-lettered' : 'job failed, will retry', {
      queue: job.queue,
      id: job.id,
      attempt: job.attempts,
      error: message,
    });
  }
}

const backoffMs = (attempt: number) => Math.min(2 ** attempt * 1000, 5 * 60_000) * (0.5 + Math.random());

function truncateResult(result: unknown): unknown {
  const text = JSON.stringify(result ?? null);
  return text.length > 4000 ? { truncated: true } : result ?? null;
}
