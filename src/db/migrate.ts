/**
 * Migrations, run by the app on every boot and guarded by a session-level
 * advisory lock: if two replicas start together, one waits here and then
 * finds nothing to do, rather than racing.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, query, waitForDatabase } from './pool.js';
import { log } from '../log.js';

const LOCK_ID = 8_147_293_001; // arbitrary but fixed: Pigeonhole's migration lock

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/db -> repo root, and src/db -> repo root when run through tsx.
  return process.env.PH_MIGRATIONS_DIR ?? join(here, '..', '..', 'migrations');
}

export async function appliedMigrations(): Promise<string[]> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum TEXT
    )
  `);
  const r = await query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
  return r.rows.map((row) => row.name);
}

async function pendingMigrations(): Promise<string[]> {
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(await appliedMigrations());
  return files.filter((f) => !applied.has(f));
}

/** Applies every pending migration, each in its own transaction. */
export async function migrate(): Promise<string[]> {
  await waitForDatabase();
  const client = await db().connect();
  const ran: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum TEXT
      )
    `);
    const dir = migrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum(sql),
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        log.error('migration failed', { migration: file, error: err });
        throw err;
      }
      ran.push(file);
      log.info('migration applied', { migration: file, duration_ms: Date.now() - started });
    }
    if (ran.length === 0) log.info('schema is up to date');
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

function checksum(sql: string): string {
  let h = 0;
  for (let i = 0; i < sql.length; i++) h = (Math.imul(31, h) + sql.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Readiness gate: false while the schema is behind the shipped migrations. */
export async function schemaIsCurrent(): Promise<boolean> {
  try {
    return (await pendingMigrations()).length === 0;
  } catch {
    return false;
  }
}
