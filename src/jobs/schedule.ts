/**
 * Nightly jobs: the drift eval of every pipeline, and the retention sweep.
 *
 * Each schedule claims its day in the `meta` table before it enqueues, in one
 * atomic statement, so a restart or a second app replica cannot fire the same
 * night twice — which would mean paying for every nightly eval twice. The
 * queue does the work.
 */
import { enqueue } from '../queue/index.js';
import { one } from '../db/pool.js';
import { config } from '../config.js';
import { log } from '../log.js';

interface Schedule {
  name: string;
  /** The UTC hour the job runs in. */
  atHourUtc: number;
  run: () => Promise<unknown>;
}

/** True for exactly one caller per schedule per day. */
async function claimDay(name: string, day: string): Promise<boolean> {
  const row = await one(
    `INSERT INTO meta (key, value) VALUES ($1, to_jsonb($2::text))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       WHERE meta.value <> EXCLUDED.value
     RETURNING key`,
    [`schedule:${name}`, day],
  );
  return row !== null;
}

const SCHEDULES: Schedule[] = [
  {
    name: 'nightly_drift',
    atHourUtc: 2,
    run: () => enqueue('drift_scan', {}),
  },
  {
    name: 'retention',
    atHourUtc: 3,
    run: () => enqueue('retention', { days: config.retentionDays }),
  },
];

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  for (const schedule of SCHEDULES) {
    if (now.getUTCHours() !== schedule.atHourUtc) continue;
    try {
      if (!(await claimDay(schedule.name, day))) continue;
      await schedule.run();
      log.info('schedule fired', { schedule: schedule.name, day });
    } catch (err) {
      log.warn('schedule failed', { schedule: schedule.name, error: (err as Error).message });
    }
  }
}

export async function startScheduler(): Promise<void> {
  // Every 10 minutes is plenty: claimDay makes each schedule fire once a day.
  timer = setInterval(() => void tick(), 10 * 60_000);
  timer.unref?.();
  void tick();
  log.info('scheduler ready', { schedules: SCHEDULES.map((s) => `${s.name}@${s.atHourUtc}:00Z`) });
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
