/**
 * The HTTP surface: classify API, control plane, builder UI and MCP, all in
 * one Fastify app.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../log.js';
import { ProblemError, problem } from '../errors.js';
import { sseTicketIdentity } from './sse.js';
import { authenticate, type Identity } from './auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerClassifyRoutes } from './routes/classify.js';
import { registerPipelineRoutes } from './routes/pipelines.js';
import { registerCompileRoutes } from './routes/compile.js';
import { registerEvalRoutes } from './routes/evals.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerMcpRoutes } from './routes/mcp.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity;
  }
}

function uiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'ui');
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,                       // structured logging goes through log.ts
    bodyLimit: config.maxBodyBytes,
  });

  app.decorateRequest('identity', null as unknown as Identity);

  app.addHook('onResponse', async (req, reply) => {
    // 4xx is logged at info, not debug. A rejected credential is the single
    // most common thing an operator has to diagnose, and at the default log
    // level it was previously invisible: "the UI keeps asking for my token"
    // left no trace at all on the server.
    const level =
      reply.statusCode >= 500 ? 'warn' : reply.statusCode >= 400 ? 'info' : 'debug';
    log[level]('request', {
      method: req.method,
      path: req.url,
      status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
      identity: req.identity?.name,
    });
  });

  // RFC 9457 problem JSON for everything, including Fastify's own errors.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ProblemError) {
      return reply
        .code(err.status)
        .type('application/problem+json')
        .send(err.toProblem(req.url));
    }
    if ((err as { statusCode?: number }).statusCode === 413) {
      const p = problem('payload_too_large', `request body is over the ${config.maxBodyBytes} byte cap`);
      return reply.code(413).type('application/problem+json').send(p.toProblem(req.url));
    }
    if ((err as { statusCode?: number }).statusCode === 400) {
      const p = problem('input_invalid', (err as Error).message);
      return reply.code(400).type('application/problem+json').send(p.toProblem(req.url));
    }
    log.error('unhandled request error', { path: req.url, error: err });
    const p = problem('internal_error', 'the server hit an unexpected error');
    return reply.code(500).type('application/problem+json').send(p.toProblem(req.url));
  });

  app.setNotFoundHandler((req, reply) => {
    const p = problem('pipeline_not_found', `no route for ${req.method} ${req.url}`);
    return reply.code(404).type('application/problem+json').send(p.toProblem(req.url));
  });

  await registerHealthRoutes(app);
  await registerClassifyRoutes(app);
  await registerPipelineRoutes(app);
  await registerCompileRoutes(app);
  await registerEvalRoutes(app);
  await registerRunRoutes(app);
  await registerAdminRoutes(app);
  await registerMcpRoutes(app);

  await app.register(fastifyStatic, { root: uiDir(), prefix: '/ui/', decorateReply: false });
  app.get('/', async (_req, reply) => reply.redirect('/ui/'));

  return app;
}

/** Applied per route rather than globally, so /healthz stays open. */
export async function authGuard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // EventSource cannot set an Authorization header, so a compile's progress
  // stream presents a short-lived ticket in its URL instead. This has to be
  // here rather than in the compile routes: several route hooks match these
  // URLs and whichever registered first is the one that decides.
  const ticketed = sseTicketIdentity(req);
  req.identity = ticketed ?? (await authenticate(req));
}

export async function startServer(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  log.info('http server listening', { port: config.port });
  return app;
}
