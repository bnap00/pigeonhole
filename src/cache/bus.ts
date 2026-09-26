/**
 * The event bus: Postgres LISTEN/NOTIFY.
 *
 * It carries spec invalidations and compile progress. Going through Postgres
 * rather than an in-process emitter means another process — `make seed`, or a
 * second app replica — still reaches the server's spec cache and a browser's
 * progress stream.
 */
import type { Client } from 'pg';
import pg from 'pg';
import { config } from '../config.js';
import { log } from '../log.js';
import { query } from '../db/pool.js';

export type BusMessage =
  | { type: 'spec_published'; pipeline: string; version: number }
  | { type: 'spec_changed'; pipeline: string }
  | { type: 'compile_progress'; compile_id: string; pipeline: string; payload: Record<string, unknown> };

const PG_CHANNEL = 'pigeonhole_events';

type Handler = (msg: BusMessage) => void;
const handlers = new Set<Handler>();
let started = false;
let pgListener: Client | null = null;

export function onBus(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function dispatch(raw: string): void {
  let msg: BusMessage;
  try {
    msg = JSON.parse(raw) as BusMessage;
  } catch {
    return;
  }
  for (const handler of handlers) {
    try {
      handler(msg);
    } catch (err) {
      log.warn('bus handler threw', { error: (err as Error).message });
    }
  }
}

export async function startBus(): Promise<void> {
  if (started) return;
  started = true;

  pgListener = new pg.Client({ connectionString: config.databaseUrl, application_name: 'pigeonhole-bus' });
  pgListener.on('notification', (n) => {
    if (n.payload) dispatch(n.payload);
  });
  pgListener.on('error', (err) => {
    log.warn('bus listener errored, reconnecting', { error: err.message });
    started = false;
    setTimeout(() => void startBus().catch(() => undefined), 2000);
  });
  await pgListener.connect();
  await pgListener.query(`LISTEN ${PG_CHANNEL}`);
  log.info('bus listening');
}

export async function publishBus(msg: BusMessage): Promise<void> {
  // pg_notify's payload limit is 8000 bytes; every message here is far smaller.
  await query('SELECT pg_notify($1, $2)', [PG_CHANNEL, JSON.stringify(msg)]);
}

export async function stopBus(): Promise<void> {
  started = false;
  handlers.clear();
  if (pgListener) {
    await pgListener.end().catch(() => undefined);
    pgListener = null;
  }
}
