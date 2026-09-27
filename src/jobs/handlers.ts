/**
 * Every background job the app runs. The app drains the queue in-process;
 * `schedule.ts` enqueues the nightly ones.
 */
import { runCompile } from '../compiler/index.js';
import { collectCases, persistEval, runEval } from '../evals/run.js';
import { assessDrift, raiseDriftAlert } from '../evals/drift.js';
import { deliverWebhook } from '../evals/notify.js';
import { classify } from '../runtime/classify.js';
import { execute } from '../executor/execute.js';
import { provider } from '../provider/index.js';
import { resolveSettings } from '../spec/parse.js';
import type { PipelineSpec } from '../spec/types.js';
import * as repo from '../db/repo.js';
import { publishBus } from '../cache/bus.js';
import { enqueue, type JobContext, type JobHandler, type JobName } from '../queue/index.js';
import { sweepRunEvents } from '../analytics/index.js';
import { config } from '../config.js';
import { log } from '../log.js';

const compileJob: JobHandler = async (payload: any) => {
  const { compile_id, pipeline, description, samples, mode, instruction, compiler_model } = payload;
  try {
    const { diff } = await runCompile({
      compileId: compile_id,
      pipelineId: pipeline,
      description,
      samples,
      mode,
      instruction,
      compilerModel: compiler_model,
      skipDryRun: payload.skip_dry_run ?? false,
    });
    return { diff };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await repo.setCompileStatus(compile_id, 'failed', { error: message });
    await publishBus({
      type: 'compile_progress',
      compile_id,
      pipeline,
      payload: { pass: 'failed', message },
    });
    throw err;
  }
};

const evalJob: JobHandler = async (payload: any, ctx: JobContext) => {
  const { pipeline, version, model, trigger = 'manual' } = payload;
  const resolved = await repo.resolveServingVersion(pipeline, version ?? null);
  const spec = resolved.spec;
  const cases = await collectCases(pipeline, spec);
  if (cases.length === 0) {
    log.info('eval skipped: no test cases', { pipeline });
    return { skipped: 'no test cases' };
  }

  const report = await runEval({
    spec,
    version: resolved.version,
    cases,
    model,
    onProgress: async (done, total, passed) => {
      await ctx.progress({ done, total, passed });
      await publishBus({
        type: 'compile_progress',
        compile_id: `eval:${pipeline}:${resolved.version}`,
        pipeline,
        payload: { pass: 'eval', message: `${passed}/${done} correct`, detail: { done, total, passed } },
      });
    },
  });

  const evalId = await persistEval(report, trigger);

  // Drift compares one measurement with the last. A run where nothing reached
  // the model is not a measurement, so it neither raises an alert nor becomes
  // the baseline tomorrow's run is compared with.
  if (trigger === 'nightly' && report.accuracy !== null) {
    const verdict = await assessDrift(report);
    if (verdict.drifted) await raiseDriftAlert(report, verdict);
  }
  return { eval_id: evalId, accuracy: report.accuracy, passed: report.passed, cases: report.cases };
};

const asyncClassifyJob: JobHandler = async (payload: any) => {
  const { pipeline, version, input, webhook, secret, run_id } = payload;
  const result = await classify({ pipelineId: pipeline, version, input, runId: run_id });
  if (webhook) {
    await enqueue('webhook', {
      url: webhook,
      secret,
      event: 'async_result',
      payload: result,
    }, { maxAttempts: 5 });
  }
  return { run_id: result.run_id };
};

/** Retries and dead-lettering are the queue's. */
const webhookJob: JobHandler = async (payload: any) => {
  await deliverWebhook({
    url: payload.url,
    secret: payload.secret,
    event: payload.event ?? 'drift',
    payload: payload.payload ?? {},
  });
  return { delivered: 'webhook' };
};

/** Shadow mode. The draft runs here rather than on the request path, so it competes with nothing. */
const shadowJob: JobHandler = async (payload: any) => {
  const { pipeline, run_id, live_version, live_output, input } = payload;
  const row = await repo.getPipeline(pipeline);
  const draft = row?.draft_spec as PipelineSpec | null;
  if (!draft) return { skipped: 'no draft spec' };

  const result = await execute({
    spec: draft,
    version: 0,
    input,
    provider: provider(),
    settings: resolveSettings(draft),
  });
  const agreed = JSON.stringify(result.output) === JSON.stringify(live_output);
  await repo.insertShadowResult({
    pipelineId: pipeline,
    runId: run_id,
    liveVersion: live_version,
    draftOutput: result.output,
    liveOutput: live_output,
    agreed,
  });
  return { agreed };
};

/** Retention: retained runs and telemetry older than the window are deleted. */
const retentionJob: JobHandler = async (payload: any) => {
  const days = payload?.days ?? config.retentionDays;
  const deletedRuns = await repo.deleteExpiredRuns(days);
  const sweptEvents = await sweepRunEvents(days);
  log.info('retention sweep done', { deleted_runs: deletedRuns, swept_events: sweptEvents });
  return { deletedRuns, sweptEvents };
};

/** Enqueues one eval per active pipeline. Fan-out; the queue does the work. */
const driftScanJob: JobHandler = async () => {
  const pipelines = await repo.listPipelines();
  let queued = 0;
  for (const pipeline of pipelines) {
    if (!pipeline.latest_version) continue;
    await enqueue(
      'eval',
      // No model override: each pipeline is evaluated on its own runtime, so a
      // pinned Jev stays pinned and a Laya pipeline is not silently run on Jev.
      { pipeline: pipeline.id, trigger: 'nightly' },
      { dedupeKey: `nightly:${pipeline.id}:${new Date().toISOString().slice(0, 10)}` },
    );
    queued++;
  }
  log.info('nightly drift scan queued', { pipelines: queued });
  return { queued };
};

export const HANDLERS: Partial<Record<JobName, JobHandler>> = {
  compile: compileJob,
  eval: evalJob,
  classify_async: asyncClassifyJob,
  webhook: webhookJob,
  shadow: shadowJob,
  retention: retentionJob,
  drift_scan: driftScanJob,
};
