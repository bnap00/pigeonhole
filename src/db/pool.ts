/** One pg pool per process, plus the helpers every query goes through. */
import pg from 'pg';
import { config } from '../config.js';
import { log } from '../log.js';

// Keep NUMERIC as a number rather than a string; every numeric column here is
// a cost or an accuracy, well inside float precision.
pg.types.setTypeParser(1700, (v: string) => (v === null ? null : Number(v)));
// BIGINT (int8) likewise: these are row ids and counts, not balances.
pg.types.setTypeParser(20, (v: string) => (v === null ? null : Number(v)));

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'pigeonhole',
    });
    pool.on('error', (err) => log.error('idle postgres client errored', { error: err }));
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return db().query<T>(text, params as never[]);
}

export async function rows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await query<T>(text, params)).rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const r = await query<T>(text, params);
  return r.rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Blocks until Postgres accepts a query, so first boot is ordered not racy. */
export async function waitForDatabase(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await query('SELECT 1');
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`postgres was not reachable within ${timeoutMs}ms: ${(lastError as Error)?.message}`);
}
