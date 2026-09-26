/**
 * Run telemetry: one row per node answer in `run_events`, powering the
 * builder's analytics panels.
 *
 * A classify response is returned before its telemetry is written. Events are
 * buffered and flushed on a timer or at a size threshold, so a slow database
 * insert slows analytics, never classification.
 */
import { query, rows } from '../db/pool.js';
import { log } from '../log.js';
import type { RunResult } from '../executor/types.js';
import type { ResolvedSettings } from '../spec/parse.js';

export interface RunEvent {
  ts: Date;
  pipeline: string;
  version: number;
  run_id: string;
  node: string;
  answer: string;
  confidence: number;
  latency_ms: number;
  input_tokens: number;
  model: string;
  low_confidence: boolean;
  cost_usd: number;
}

export interface Overview {
  runs: number;
  low_confidence_rate: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  total_input_tokens: number;
  est_cost_usd: number;
  by_day: { day: string; runs: number; low_confidence: number; avg_latency_ms: number }[];
}

export interface OptionDistribution {
  node: string;
  options: { answer: string; runs: number; avg_confidence: number; low_confidence: number }[];
}

const buffer: RunEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_SIZE = 500;
const FLUSH_MS = 2000;

/** Turns one run into one event per node answer. */
export function runToEvents(result: RunResult): RunEvent[] {
  const ts = new Date();
  const events: RunEvent[] = [];
  for (const [node, answer] of Object.entries(result.nodes)) {
    if (answer.skipped) continue;
    const value =
      answer.choice ??
      (answer.score !== undefined ? String(answer.score) : undefined) ??
      (answer.p !== undefined ? (answer.p >= 0.5 ? 'true' : 'false') : undefined) ??
      (answer.value !== undefined && answer.value !== null ? String(answer.value) : '');
    events.push({
      ts,
      pipeline: result.pipeline,
      version: result.version,
      run_id: result.run_id,
      node,
      answer: String(value).slice(0, 128),
      confidence: answer.confidence ?? 0,
      latency_ms: result.latency_ms,
      input_tokens: result.usage.input_tokens,
      model: result.model,
      low_confidence: Boolean(answer.low_confidence),
      cost_usd: result.usage.cost_usd ?? 0,
    });
  }
  return events;
}

export function recordRun(result: RunResult, settings: ResolvedSettings): void {
  if (!settings.telemetry) return;
  buffer.push(...runToEvents(result));
  if (buffer.length >= FLUSH_SIZE) {
    void flushTelemetry();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flushTelemetry(), FLUSH_MS);
    flushTimer.unref?.();
  }
}

export async function flushTelemetry(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    await insertEvents(batch);
  } catch (err) {
    // Telemetry loss must never fail a request or crash a worker. It is
    // counted and logged so the gap is visible rather than silent.
    droppedEvents += batch.length;
    log.warn('telemetry batch dropped', { events: batch.length, total_dropped: droppedEvents, error: (err as Error).message });
  }
}

let droppedEvents = 0;
export const telemetryStats = () => ({ buffered: buffer.length, dropped: droppedEvents });

/**
 * Decides whether this run's full payload is kept in Postgres. Telemetry is
 * always recorded; this is only about the row with the input and answers in it.
 */
export function retainReason(result: RunResult, settings: ResolvedSettings): string | null {
  switch (settings.retain) {
    case 'none':
      return null;
    case 'all':
      return 'all';
    case 'low_confidence':
      return result.needs_review || Object.values(result.nodes).some((n) => n.low_confidence)
        ? 'low_confidence'
        : null;
    case 'sampled':
      return Math.random() < settings.sampleRate ? 'sampled' : null;
    default:
      return null;
  }
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const CARD = /\b(?:\d[ -]*?){13,16}\b/g;

/** Applied before an input is written, when `redact_pii` is on. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(EMAIL, '[email]')
      .replace(CARD, '[card]')
      .replace(PHONE, '[phone]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

/** Shapes the input for storage according to the pipeline's logging setting. */
export function inputForStorage(input: unknown, settings: ResolvedSettings): unknown | null {
  if (settings.inputLogging === 'off') return null;
  if (settings.inputLogging === 'hash_only') return null;
  return settings.redactPii ? redact(input) : input;
}

async function insertEvents(events: RunEvent[]): Promise<void> {
  if (events.length === 0) return;
  // One multi-row insert; the values list is built from a fixed column
  // count, so the parameter numbering cannot drift.
  const cols = 11;
  const values: unknown[] = [];
  const tuples = events.map((e, i) => {
    values.push(
      e.ts, e.pipeline, e.version, e.run_id, e.node, e.answer,
      e.confidence, e.latency_ms, e.input_tokens, e.model, e.low_confidence,
    );
    const base = i * cols;
    return `(${Array.from({ length: cols }, (_, k) => `$${base + k + 1}`).join(',')})`;
  });
  await query(
    `INSERT INTO run_events
       (ts, pipeline, version, run_id, node, answer, confidence, latency_ms, input_tokens, model, low_confidence)
     VALUES ${tuples.join(',')}`,
    values,
  );
}

// ------------------------------------------------------------- queries

export async function overview(pipeline: string, days: number): Promise<Overview> {
  const totals = await rows<any>(
    `SELECT count(*)::int AS runs,
            avg(latency_ms) AS avg_latency,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency,
            COALESCE(sum(input_tokens), 0)::bigint AS tokens,
            count(*) FILTER (WHERE low_confidence)::int AS low_conf
       FROM run_events
      WHERE pipeline = $1 AND ts > now() - ($2 || ' days')::interval`,
    [pipeline, days],
  );
  const byDay = await rows<any>(
    `SELECT date_trunc('day', ts)::date AS day, count(*)::int AS runs,
            count(*) FILTER (WHERE low_confidence)::int AS low_confidence,
            avg(latency_ms) AS avg_latency_ms
       FROM run_events
      WHERE pipeline = $1 AND ts > now() - ($2 || ' days')::interval
      GROUP BY day ORDER BY day`,
    [pipeline, days],
  );
  const t = totals[0] ?? {};
  const runs = Number(t.runs ?? 0);
  return {
    runs,
    low_confidence_rate: runs > 0 ? Number(t.low_conf) / runs : 0,
    avg_latency_ms: Math.round(Number(t.avg_latency ?? 0)),
    p95_latency_ms: Math.round(Number(t.p95_latency ?? 0)),
    total_input_tokens: Number(t.tokens ?? 0),
    // Jev's published input rate is the basis; the UI labels it an estimate.
    est_cost_usd: (Number(t.tokens ?? 0) / 1_000_000) * 0.042,
    by_day: byDay.map((d) => ({
      day: new Date(d.day).toISOString().slice(0, 10),
      runs: Number(d.runs),
      low_confidence: Number(d.low_confidence),
      avg_latency_ms: Math.round(Number(d.avg_latency_ms ?? 0)),
    })),
  };
}

export async function distribution(pipeline: string, days: number): Promise<OptionDistribution[]> {
  const r = await rows<any>(
    `SELECT node, answer, count(*)::int AS runs, avg(confidence) AS avg_confidence,
            count(*) FILTER (WHERE low_confidence)::int AS low_confidence
       FROM run_events
      WHERE pipeline = $1 AND ts > now() - ($2 || ' days')::interval
      GROUP BY node, answer ORDER BY node, runs DESC`,
    [pipeline, days],
  );
  return groupDistribution(r);
}

export async function confidenceHistogram(pipeline: string, node: string, days: number) {
  const r = await rows<any>(
    `SELECT floor(confidence * 10) / 10 AS bucket, count(*)::int AS runs
       FROM run_events
      WHERE pipeline = $1 AND node = $2 AND ts > now() - ($3 || ' days')::interval
      GROUP BY bucket ORDER BY bucket`,
    [pipeline, node, days],
  );
  return r.map((x) => ({ bucket: Number(x.bucket), runs: Number(x.runs) }));
}

function groupDistribution(rows: any[]): OptionDistribution[] {
  const byNode = new Map<string, OptionDistribution>();
  for (const r of rows) {
    const node = String(r.node);
    if (!byNode.has(node)) byNode.set(node, { node, options: [] });
    byNode.get(node)!.options.push({
      answer: String(r.answer),
      runs: Number(r.runs),
      avg_confidence: Number(r.avg_confidence ?? 0),
      low_confidence: Number(r.low_confidence ?? 0),
    });
  }
  return [...byNode.values()];
}

/** Retention: telemetry rows older than the window are deleted nightly. */
export async function sweepRunEvents(retentionDays: number): Promise<number> {
  const r = await query(
    `DELETE FROM run_events WHERE ts < now() - ($1 || ' days')::interval`,
    [retentionDays],
  );
  return r.rowCount ?? 0;
}
