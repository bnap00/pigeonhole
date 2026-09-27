/**
 * Drift detection.
 *
 * The nightly eval runs each pipeline on its own runtime model (`jev-latest`
 * unless the spec says otherwise) whether or not the spec changed.
 * When the resolved model version moves AND accuracy falls by more than the
 * threshold, that is drift: the pipeline got worse without anyone touching it.
 *
 * A pipeline pinned to `runtime: typesafe/jev-1.13` stays pinned and is reported as
 * unaffected, which is the point of pinning.
 */
import * as repo from '../db/repo.js';
import { enqueue } from '../queue/index.js';
import { config } from '../config.js';
import { log } from '../log.js';
import type { EvalReport } from './run.js';
import { topConfusions } from './run.js';

export interface DriftVerdict {
  drifted: boolean;
  model_changed: boolean;
  from_model: string | null;
  to_model: string;
  from_accuracy: number | null;
  to_accuracy: number;
  delta: number | null;
  reason: string;
}

export async function assessDrift(evaluated: EvalReport): Promise<DriftVerdict> {
  if (evaluated.accuracy === null) throw new Error('assessDrift needs a run that measured something');
  const report = { ...evaluated, accuracy: evaluated.accuracy };
  const previous = await repo.lastNightlyEval(report.pipeline);
  const verdict: DriftVerdict = {
    drifted: false,
    model_changed: false,
    from_model: previous?.resolved_model ?? null,
    to_model: report.resolved_model,
    from_accuracy: previous?.accuracy ?? null,
    to_accuracy: report.accuracy,
    delta: previous ? report.accuracy - previous.accuracy : null,
    reason: 'no previous nightly eval to compare against',
  };

  if (!previous) return verdict;

  verdict.model_changed = Boolean(
    previous.resolved_model && previous.resolved_model !== report.resolved_model,
  );
  const delta = report.accuracy - previous.accuracy;
  verdict.delta = delta;

  if (verdict.model_changed && delta < -config.driftThreshold) {
    verdict.drifted = true;
    verdict.reason =
      `the resolved model moved from ${previous.resolved_model} to ${report.resolved_model} ` +
      `and accuracy fell ${(Math.abs(delta) * 100).toFixed(1)} points ` +
      `(${(previous.accuracy * 100).toFixed(1)}% to ${(report.accuracy * 100).toFixed(1)}%)`;
  } else if (delta < -config.driftThreshold) {
    // Same model, worse results: usually a flaky eval set or a spec edit, but
    // worth surfacing rather than swallowing.
    verdict.drifted = true;
    verdict.reason =
      `accuracy fell ${(Math.abs(delta) * 100).toFixed(1)} points on the same model ` +
      `(${report.resolved_model})`;
  } else if (verdict.model_changed) {
    verdict.reason = `the model moved to ${report.resolved_model} with no accuracy regression`;
  } else {
    verdict.reason = 'no significant change';
  }
  return verdict;
}

/** Logs the alert and queues a delivery to every drift webhook. Nothing is sent inline. */
export async function raiseDriftAlert(report: EvalReport, verdict: DriftVerdict): Promise<void> {
  const payload = {
    pipeline: report.pipeline,
    version: report.version,
    reason: verdict.reason,
    from_model: verdict.from_model,
    to_model: verdict.to_model,
    from_accuracy: verdict.from_accuracy,
    to_accuracy: verdict.to_accuracy,
    delta: verdict.delta,
    cases: report.cases,
    top_confusions: topConfusions(report, 5),
    pinning_hint:
      `To hold this pipeline steady, set \`model.runtime: ${verdict.from_model ?? 'typesafe/jev-1.13'}\` ` +
      'and move only after a green eval.',
  };

  const hooks = await repo.listWebhooks(report.pipeline, 'drift');
  for (const hook of hooks) {
    await enqueue('webhook', { url: hook.url, secret: hook.secret, event: 'drift', payload });
  }

  log.warn('drift detected', {
    pipeline: report.pipeline,
    reason: verdict.reason,
    webhooks: hooks.length,
  });
}
