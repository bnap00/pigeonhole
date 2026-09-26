/**
 * The runtime API: the only endpoints that matter to a caller in production.
 */
import type { FastifyInstance } from 'fastify';
import { authGuard } from '../app.js';
import { requirePipelineAccess, requireScope } from '../auth.js';
import { consume } from '../ratelimit.js';
import { classify, classifyBatch } from '../../runtime/classify.js';
import { enqueue } from '../../queue/index.js';
import { newRunId } from '../../executor/execute.js';
import { problem } from '../../errors.js';
import { config } from '../../config.js';

interface ClassifyBody {
  input?: unknown;
  inputs?: unknown[];
  webhook?: string;
  webhook_secret?: string;
}

/** Accepts `support-triage` and `support-triage@3`. */
function splitPipeline(raw: string): { id: string; version: number | null } {
  const at = raw.lastIndexOf('@');
  if (at <= 0) return { id: raw, version: null };
  const version = Number(raw.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) {
    throw problem('input_invalid', `"${raw.slice(at + 1)}" is not a version number`);
  }
  return { id: raw.slice(0, at), version };
}

export async function registerClassifyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/classify') && !req.url.startsWith('/v1/runs')) return;
    await authGuard(req, reply);
  });

  app.post<{ Params: { pipeline: string }; Body: ClassifyBody; Querystring: { detail?: string } }>(
    '/v1/classify/:pipeline',
    async (req, reply) => {
      const { id, version } = splitPipeline(req.params.pipeline);
      requireScope(req.identity, 'classify');
      requirePipelineAccess(req.identity, id);
      const limit = consume(req.identity.keyId ?? req.ip);

      if (req.body?.input === undefined) {
        throw problem('input_invalid', 'request body must contain `input`');
      }

      const result = await classify({
        pipelineId: id,
        version,
        input: req.body.input,
        detail: req.query.detail === 'output' ? 'output' : 'full',
      });

      reply
        .header('x-ratelimit-limit', String(limit.limit))
        .header('x-ratelimit-remaining', String(limit.remaining))
        .header('x-pigeonhole-version', String(result.version));
      return result;
    },
  );

  /**
   * Unbounded batch. There is no subrequest cap to respect here, so the size
   * limit is the body cap and the concurrency ceiling, not an arbitrary 100.
   */
  app.post<{ Params: { pipeline: string }; Body: ClassifyBody; Querystring: { detail?: string } }>(
    '/v1/classify/:pipeline/batch',
    async (req) => {
      const { id, version } = splitPipeline(req.params.pipeline);
      requireScope(req.identity, 'classify');
      requirePipelineAccess(req.identity, id);

      const inputs = req.body?.inputs;
      if (!Array.isArray(inputs) || inputs.length === 0) {
        throw problem('input_invalid', 'request body must contain a non-empty `inputs` array');
      }
      // One rate-limit unit per input, so a batch cannot bypass the limit.
      consume(req.identity.keyId ?? req.ip, config.rateLimitPerMinute);

      const started = Date.now();
      const { results, ok, failed } = await classifyBatch(
        id,
        inputs,
        version,
        req.query.detail === 'output' ? 'output' : 'full',
      );
      return {
        pipeline: id,
        count: inputs.length,
        ok,
        failed,
        duration_ms: Date.now() - started,
        results,
      };
    },
  );

  /** Queue a job, answer on a webhook. Retried with backoff, dead-lettered after 5. */
  app.post<{ Params: { pipeline: string }; Body: ClassifyBody }>(
    '/v1/classify/:pipeline/async',
    async (req, reply) => {
      const { id, version } = splitPipeline(req.params.pipeline);
      requireScope(req.identity, 'classify');
      requirePipelineAccess(req.identity, id);
      consume(req.identity.keyId ?? req.ip);

      if (req.body?.input === undefined) {
        throw problem('input_invalid', 'request body must contain `input`');
      }
      const runId = newRunId();
      const jobId = await enqueue('classify_async', {
        pipeline: id,
        version,
        input: req.body.input,
        webhook: req.body.webhook,
        secret: req.body.webhook_secret,
        run_id: runId,
      });

      reply.code(202);
      return {
        run_id: runId,
        job_id: jobId,
        pipeline: id,
        status: 'queued',
        status_url: `/v1/runs/${runId}`,
      };
    },
  );
}
