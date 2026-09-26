/**
 * Liveness, readiness and status. Unauthenticated: Docker health-gates on them.
 *
 * /readyz reports the schema state and the database, so a stuck boot says
 * what it is waiting for rather than just failing. It deliberately does not
 * call the model provider: OpenRouter being down should not mark the app
 * unhealthy.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { schemaIsCurrent } from '../../db/migrate.js';
import { query } from '../../db/pool.js';
import { telemetryStats } from '../../analytics/index.js';
import { specCacheStats } from '../../cache/specs.js';

const startedAt = Date.now();

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({
    status: 'ok',
    version: config.version,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
  }));

  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      await query('SELECT 1');
      checks.postgres = { ok: true };
    } catch (err) {
      checks.postgres = { ok: false, detail: (err as Error).message };
    }

    const migrated = await schemaIsCurrent();
    checks.migrations = {
      ok: migrated,
      ...(migrated ? {} : { detail: 'migrations have not finished' }),
    };

    const ready = Object.values(checks).every((c) => c.ok);
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', version: config.version, checks };
  });

  /** Everything the UI needs to describe the app it is talking to. */
  app.get('/v1/status', async () => ({
    version: config.version,
    runtime_model: config.defaultRuntimeModel,
    compiler_model: config.defaultCompilerModel,
    spec_cache: specCacheStats(),
    telemetry: telemetryStats(),
  }));
}
