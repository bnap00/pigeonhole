/** Run log, feedback and the review queue that turns corrections into tests. */
import type { FastifyInstance } from 'fastify';
import { authGuard } from '../app.js';
import { requireScope } from '../auth.js';
import * as repo from '../../db/repo.js';
import { problem } from '../../errors.js';

type Body = Record<string, any>;

export async function registerRunRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!/\/(runs|feedback|review)/.test(req.url)) return;
    await authGuard(req, reply);
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/v1/pipelines/:id/runs',
    async (req) => {
      requireScope(req.identity, 'admin');
      const runs = await repo.queryRuns({
        pipelineId: req.params.id,
        limit: Number(req.query.limit ?? 50),
        before: req.query.before,
        lowConfidenceOnly: req.query.low_confidence === 'true',
        needsReview: req.query.needs_review === 'true',
        version: req.query.version ? Number(req.query.version) : undefined,
        search: req.query.q,
      });
      return {
        runs,
        note:
          runs.length === 0
            ? 'No retained runs. Run payload retention is per pipeline via `compose.logging.retain`; telemetry is recorded separately and always.'
            : undefined,
      };
    },
  );

  app.get<{ Params: { runId: string } }>('/v1/runs/:runId', async (req) => {
    const run = await repo.getRun(req.params.runId);
    if (!run) {
      throw problem(
        'run_not_found',
        'no retained run with that id. It may have been outside this pipeline\'s retain policy, or past its retention window.',
      );
    }
    return { run };
  });

  /**
   * Feedback from callers or reviewers. This is the front of the loop that
   * turns production mistakes into test cases.
   */
  app.post<{ Params: { runId: string }; Body: Body }>('/v1/runs/:runId/feedback', async (req) => {
    requireScope(req.identity, 'classify');
    const run = await repo.getRun(req.params.runId);
    if (!run) throw problem('run_not_found', 'no retained run with that id');

    const correct = req.body?.correct_output ?? null;
    const isCorrect = req.body?.is_correct ?? (correct ? false : null);
    const row = await repo.addFeedback({
      runId: req.params.runId,
      pipelineId: run.pipeline_id,
      correctOutput: correct,
      isCorrect,
      reviewer: req.identity.name,
      note: req.body?.note,
    });

    // One click promotes a corrected run to a test case, as the spec's
    // feedback loop describes.
    let promoted: number | null = null;
    if (req.body?.promote_to_test && correct && run.input) {
      const test = await repo.addTestCase(
        run.pipeline_id,
        { name: `from run ${run.id}`, input: run.input as Record<string, unknown>, expect: correct },
        'feedback',
      );
      promoted = test!.id;
      await repo.markFeedbackPromoted(row!.id, test!.id);
    }
    return { feedback_id: row!.id, promoted_test_id: promoted };
  });

  /** The review queue: retained runs with no feedback yet, worst first. */
  app.get<{ Params: { id: string } }>('/v1/pipelines/:id/review', async (req) => {
    requireScope(req.identity, 'admin');
    const runs = await repo.queryRuns({
      pipelineId: req.params.id,
      needsReview: true,
      lowConfidenceOnly: true,
      limit: 100,
    });
    return { queue: runs, count: runs.length };
  });

  app.get<{ Params: { id: string } }>('/v1/pipelines/:id/feedback', async (req) => {
    requireScope(req.identity, 'admin');
    return { feedback: await repo.listFeedback(req.params.id) };
  });

  /** Promote an existing feedback correction to a test case. */
  app.post<{ Params: { id: string; runId: string } }>(
    '/v1/pipelines/:id/review/:runId/promote',
    async (req) => {
      requireScope(req.identity, 'admin');
      const run = await repo.getRun(req.params.runId);
      if (!run || !run.input) throw problem('run_not_found', 'no retained run with an input to promote');
      const test = await repo.addTestCase(
        req.params.id,
        { name: `from run ${run.id}`, input: run.input as Record<string, unknown>, expect: run.output },
        'feedback',
      );
      return { test_id: test!.id };
    },
  );

  /** Re-run a stored input against the current serving version. */
  app.post<{ Params: { runId: string } }>('/v1/runs/:runId/replay', async (req) => {
    requireScope(req.identity, 'admin');
    const run = await repo.getRun(req.params.runId);
    if (!run || run.input === null) {
      throw problem('run_not_found', 'this run has no stored input to replay');
    }
    const { classify } = await import('../../runtime/classify.js');
    const result = await classify({ pipelineId: run.pipeline_id, input: run.input });
    return {
      original: { version: run.version, output: run.output, model: run.model },
      replay: { version: result.version, output: result.output, model: result.model },
      changed: JSON.stringify(run.output) !== JSON.stringify(result.output),
    };
  });
}
