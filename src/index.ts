/**
 * The app's entrypoint: one process serves the API and UI, drains the job
 * queue and runs the nightly schedule. Postgres is its only dependency.
 */
import { config } from './config.js';
import { log } from './log.js';
import { migrate } from './db/migrate.js';
import { closeDb, waitForDatabase } from './db/pool.js';
import { startBus, stopBus } from './cache/bus.js';
import { startServer } from './server/app.js';
import { startScheduler, stopScheduler } from './jobs/schedule.js';
import { HANDLERS } from './jobs/handlers.js';
import { closeQueue, consume } from './queue/index.js';
import { flushTelemetry } from './analytics/index.js';
import { seedIfEmpty } from './seed.js';
import type { FastifyInstance } from 'fastify';

const JOB_CONCURRENCY = 4;

let server: FastifyInstance | null = null;

async function main(): Promise<void> {
  log.info('pigeonhole starting', { version: config.version, node: process.version });

  if (!config.adminToken) {
    throw new Error('PH_ADMIN_TOKEN is not set. Run `make init`, or set it in .env.');
  }
  if (!config.openrouterApiKey) {
    log.warn('OPENROUTER_API_KEY is not set: compiling, and classifying on Jev, will fail until it is');
  }

  await waitForDatabase();
  // Under an advisory lock, so two replicas starting together cannot race.
  await migrate();
  await startBus();
  await seedIfEmpty();
  server = await startServer();
  await consume(HANDLERS, JOB_CONCURRENCY);
  await startScheduler();
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });

  const deadline = setTimeout(() => {
    log.warn('shutdown timed out, exiting anyway');
    process.exit(1);
  }, 15_000);
  deadline.unref?.();

  try {
    stopScheduler();
    await closeQueue();
    await server?.close();
    // Flush buffered telemetry before the pool goes, so the last runs are kept.
    await flushTelemetry();
    await stopBus();
    await closeDb();
  } catch (err) {
    log.warn('error during shutdown', { error: (err as Error).message });
  }
  clearTimeout(deadline);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', { error: reason });
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: err });
  void shutdown('uncaughtException');
});

main().catch((err) => {
  log.error('failed to start', { error: err });
  process.exit(1);
});
