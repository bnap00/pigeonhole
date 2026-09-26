/** Eval endpoints, plus the analytics the builder's panels read. */
import type { FastifyInstance } from 'fastify';
import { authGuard } from '../app.js';
import { requireScope } from '../auth.js';
import * as repo from '../../db/repo.js';
import { enqueue } from '../../queue/index.js';
import { collectCases, runEval, topConfusions } from '../../evals/run.js';
import { confidenceHistogram, distribution, overview } from '../../analytics/index.js';
import { problem } from '../../errors.js';

type Body = Record<string, any>;

export async function registerEvalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!/\/(evals|analytics)/.test(req.url)) return;
    await authGuard(req, reply);
    requireScope(req.identity, 'admin');
  });

  app.post<{ Params: { id: string }; Body: Body; Querystring: { wait?: string } }>(
    '/v1/pipelines/:id/evals',
    async (req, reply) => {
      const serving = await repo.resolveServingVersion(req.params.id, req.body?.version ?? null);
      const cases = await collectCases(req.params.id, serving.spec);
      if (cases.length === 0) {
        throw problem('conflict', 'this pipeline has no test cases to evaluate');
      }

      // A small eval is faster to run inline than to queue and poll.
      if (req.query.wait === 'true' && cases.length <= 50) {
        const report = await runEval({
          spec: serving.spec,
          version: serving.version,
          cases,
          model: req.body?.model,
        });
        const { persistEval } = await import('../../evals/run.js');
        const evalId = await persistEval(report, 'manual');
        return { eval_id: evalId, ...summary(report), top_confusions: topConfusions(report), failures: report.failures.slice(0, 25) };
      }

      const jobId = await enqueue('eval', {
        pipeline: req.params.id,
        version: serving.version,
        model: req.body?.model,
        trigger: 'manual',
      });
      reply.code(202);
      return { job_id: jobId, pipeline: req.params.id, version: serving.version, cases: cases.length, status: 'queued' };
    },
  );

  app.get<{ Params: { id: string } }>('/v1/pipelines/:id/evals', async (req) => ({
    evals: await repo.listEvalRuns(req.params.id),
  }));

  app.get<{ Params: { id: string; evalId: string } }>(
    '/v1/pipelines/:id/evals/:evalId',
    async (req) => {
      const row = await repo.getEvalRun(req.params.id, Number(req.params.evalId));
      if (!row) throw problem('run_not_found', 'no such eval');
      const { report, ...summary } = row as Record<string, unknown>;
      return { eval: summary, report: report ?? null, report_available: Boolean(report) };
    },
  );

  /**
   * Compare two models or two versions on the same test set. This is what
   * `pigeonhole diff --models typesafe/jev-1.13,jev-latest` calls.
   */
  app.post<{ Params: { id: string }; Body: Body }>('/v1/pipelines/:id/compare', async (req) => {
    const left = req.body?.left ?? {};
    const right = req.body?.right ?? {};
    const leftVersion = await repo.resolveServingVersion(req.params.id, left.version ?? null);
    const rightVersion = await repo.resolveServingVersion(req.params.id, right.version ?? null);
    const cases = await collectCases(req.params.id, leftVersion.spec);
    if (cases.length === 0) throw problem('conflict', 'this pipeline has no test cases to compare on');

    const [a, b] = await Promise.all([
      runEval({ spec: leftVersion.spec, version: leftVersion.version, cases, model: left.model }),
      runEval({ spec: rightVersion.spec, version: rightVersion.version, cases, model: right.model }),
    ]);
    return {
      cases: cases.length,
      left: { ...summary(a), label: left.model ?? `v${leftVersion.version}` },
      right: { ...summary(b), label: right.model ?? `v${rightVersion.version}` },
      delta: a.accuracy === null || b.accuracy === null ? null : b.accuracy - a.accuracy,
      regressions: a.failures.length < b.failures.length ? b.failures.slice(0, 20) : [],
    };
  });

  // ---------------------------------------------------------------- analytics

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/v1/pipelines/:id/analytics',
    async (req) => {
      const days = Math.min(Number(req.query.days ?? 30), 365);
      const [summary, options] = await Promise.all([
        overview(req.params.id, days),
        distribution(req.params.id, days),
      ]);
      return { days, overview: summary, distribution: options };
    },
  );

  app.get<{ Params: { id: string; node: string }; Querystring: { days?: string } }>(
    '/v1/pipelines/:id/analytics/:node/confidence',
    async (req) => ({
      node: req.params.node,
      histogram: await confidenceHistogram(
        req.params.id,
        req.params.node,
        Math.min(Number(req.query.days ?? 30), 365),
      ),
    }),
  );
}

function summary(report: Awaited<ReturnType<typeof runEval>>) {
  return {
    accuracy: report.accuracy,
    passed: report.passed,
    cases: report.cases,
    resolved_model: report.resolved_model,
    node_accuracy: report.node_accuracy,
    key_accuracy: report.key_accuracy,
    calibration: report.calibration,
    duration_ms: report.duration_ms,
    // `errors` is truncated for the payload, so the count travels separately.
    // Reporting `errors.length` to the caller would say "10 of 25 cases could
    // not run" for a suite where all 25 failed, which reads as a partial
    // problem rather than a suite that never ran.
    errored: report.errored,
    error_kinds: report.error_kinds,
    errors: report.errors.slice(0, 10),
  };
}
