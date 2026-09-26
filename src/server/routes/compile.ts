/**
 * Compile endpoints.
 *
 * A compile is 4 to 6 model calls plus a dry run, so it is always a job:
 * POST returns 202 with an id and an SSE URL, and the UI streams pass-level
 * progress from there. `?wait=true` blocks for up to 60 seconds, which is what
 * a CI script wants.
 */
import type { FastifyInstance } from 'fastify';
import { authGuard } from '../app.js';
import { requireScope } from '../auth.js';
import * as repo from '../../db/repo.js';
import { enqueue } from '../../queue/index.js';
import { estimateCost, newCompileId } from '../../compiler/index.js';
import { mintSseTicket, openSse, streamCompileProgress } from '../sse.js';
import { problem } from '../../errors.js';
import { config } from '../../config.js';
import { validate } from '../../spec/parse.js';
import { invalidateSpec } from '../../cache/specs.js';
import type { PipelineSpec } from '../../spec/types.js';

type Body = Record<string, any>;

export async function registerCompileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!/\/compile/.test(req.url)) return;
    await authGuard(req, reply);
    requireScope(req.identity, 'admin');
  });

  app.post<{ Params: { id: string }; Body: Body; Querystring: { wait?: string } }>(
    '/v1/pipelines/:id/compile',
    async (req, reply) => {
      const pipeline = await repo.requirePipeline(req.params.id);
      const mode = req.body?.instruction ? 'incremental' : 'full';
      const description = String(req.body?.description ?? pipeline.description ?? '').trim();
      if (mode === 'full' && description.length < 10) {
        throw problem('input_invalid', 'a compile needs a description of at least 10 characters');
      }

      const estimate = estimateCost(description, mode);
      // The budget check is the job's first gate and is transactional, so two
      // compiles starting together cannot both slip under the limit.
      const budget = await repo.reserveCompileBudget(estimate, config.compileBudgetUsd);
      if (!budget.ok) {
        throw problem(
          'budget_exceeded',
          `this compile is estimated at $${estimate.toFixed(2)}, which would exceed the monthly compile budget of $${budget.limit.toFixed(2)} (spent $${budget.spent.toFixed(2)})`,
          { estimate_usd: estimate, spent_usd: budget.spent, limit_usd: budget.limit },
        );
      }

      const compileId = newCompileId();
      await repo.createCompileRun({
        id: compileId,
        pipelineId: req.params.id,
        description,
        mode,
        instruction: req.body?.instruction,
        costEstimate: estimate,
      });
      const jobId = await enqueue('compile', {
        compile_id: compileId,
        pipeline: req.params.id,
        description,
        samples: req.body?.samples ?? [],
        mode,
        instruction: req.body?.instruction,
        compiler_model: req.body?.compiler_model,
        skip_dry_run: req.body?.skip_dry_run ?? false,
      }, { maxAttempts: 3 });
      await repo.setCompileStatus(compileId, 'queued', { job_id: jobId });

      if (req.query.wait === 'true') {
        const finished = await waitForCompile(compileId, 60_000);
        if (finished) return finished;
      }

      const ticket = mintSseTicket(compileId);
      reply.code(202);
      return {
        compile_id: compileId,
        pipeline: req.params.id,
        status: 'queued',
        mode,
        cost_estimate_usd: Number(estimate.toFixed(4)),
        budget: { spent_usd: budget.spent, limit_usd: budget.limit },
        status_url: `/v1/pipelines/${req.params.id}/compile/${compileId}`,
        events_url: `/v1/pipelines/${req.params.id}/compile/${compileId}/events?ticket=${ticket}`,
      };
    },
  );

  app.get<{ Params: { id: string; compileId: string }; Querystring: { wait?: string } }>(
    '/v1/pipelines/:id/compile/:compileId',
    async (req) => {
      if (req.query.wait === 'true') {
        const finished = await waitForCompile(req.params.compileId, 60_000);
        if (finished) return finished;
      }
      const row = await repo.getCompileRun(req.params.compileId);
      if (!row) throw problem('pipeline_not_found', 'no such compile');
      return shape(row);
    },
  );

  app.get<{ Params: { id: string } }>('/v1/pipelines/:id/compiles', async (req) => ({
    compiles: (await repo.listCompileRuns(req.params.id)).map(shape),
  }));

  /** The SSE stream the builder listens to while a compile runs. */
  app.get<{ Params: { id: string; compileId: string } }>(
    '/v1/pipelines/:id/compile/:compileId/events',
    async (req, reply) => {
      const row = await repo.getCompileRun(req.params.compileId);
      if (!row) throw problem('pipeline_not_found', 'no such compile');

      const stream = openSse(reply);
      // Replay the state so far, so a browser that connects late is not blank.
      stream.send('progress', { ...row.progress, status: row.status });

      if (row.status === 'done' || row.status === 'failed') {
        stream.send('done', { pass: row.status, message: row.error ?? 'already finished' });
        stream.close();
        return reply;
      }
      const unsubscribe = streamCompileProgress(stream, req.params.compileId, () => {
        unsubscribe();
        stream.close();
      });
      reply.raw.on('close', unsubscribe);
      return reply;
    },
  );

  /** Accept a finished compile's result as the new draft. Nothing goes live here. */
  app.post<{ Params: { id: string; compileId: string }; Body: Body }>(
    '/v1/pipelines/:id/compile/:compileId/accept',
    async (req) => {
      const row = await repo.getCompileRun(req.params.compileId);
      if (!row) throw problem('pipeline_not_found', 'no such compile');
      if (row.status !== 'done' || !row.result_spec) {
        throw problem('conflict', `compile is ${row.status}; there is nothing to accept yet`);
      }
      const spec = validate(row.result_spec as unknown as Record<string, unknown>) as PipelineSpec;
      await repo.updateDraft(req.params.id, spec, spec.description);
      if (spec.tests?.length) {
        await repo.replaceCompilerTests(req.params.id, spec.tests);
      }
      await invalidateSpec(req.params.id);
      return { accepted: true, draft: spec, diff: row.diff };
    },
  );
}

function shape(row: repo.CompileRunRow) {
  return {
    compile_id: row.id,
    pipeline: row.pipeline_id,
    status: row.status,
    mode: row.mode,
    progress: row.progress,
    passes_done: Object.keys(row.passes ?? {}),
    diff: row.diff,
    spec: row.result_spec,
    cost_estimate_usd: row.cost_estimate,
    actual_cost_usd: row.actual_cost,
    error: row.error,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

/** Polls the row rather than the bus, so it works from any process. */
async function waitForCompile(compileId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await repo.getCompileRun(compileId);
    if (row && (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled')) {
      return shape(row);
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  return null;
}
