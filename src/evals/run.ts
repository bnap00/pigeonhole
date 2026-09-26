/**
 * The eval runner.
 *
 * Evals are the reason to use Pigeonhole rather than calling a model directly:
 * `jev-latest` moves to new releases on its own, so a pipeline's behaviour can
 * change with no change on your side. An eval is what notices.
 *
 * Scale is a real advantage of this substrate. A 10,000-case regression run is
 * an ordinary background job here — no step chunking, no invocation limit, no
 * subrequest budget.
 */
import { execute } from '../executor/execute.js';
import { matchesExpectation, resolveSettings } from '../spec/parse.js';
import type { PipelineSpec } from '../spec/types.js';
import { provider } from '../provider/index.js';
import type { Provider } from '../provider/types.js';
import * as repo from '../db/repo.js';
import { log } from '../log.js';
import { ProblemError } from '../errors.js';

export interface EvalCase {
  name?: string;
  input: unknown;
  expect: Record<string, unknown>;
}

export interface EvalReport {
  pipeline: string;
  version: number;
  model: string;
  resolved_model: string;
  cases: number;
  passed: number;
  /**
   * Share of the cases that reached the model and were answered correctly.
   * Null when none did. A case that threw — a provider outage, an input the
   * schema rejects — is not evidence about the pipeline, so it is counted in
   * `errored`, never as a wrong answer. Counting it as wrong turned a provider
   * outage into "accuracy fell 100 points", which is a drift alert.
   */
  accuracy: number | null;
  /** Cases that never reached the model. */
  errored: number;
  /** Why they did not, by problem code: provider_error, input_invalid, … */
  error_kinds: Record<string, number>;
  duration_ms: number;
  /** Per output key, and per node. */
  key_accuracy: Record<string, { passed: number; total: number; accuracy: number }>;
  node_accuracy: Record<string, { passed: number; total: number; accuracy: number }>;
  /** node -> expected -> actual -> count */
  confusion: Record<string, Record<string, Record<string, number>>>;
  /** node -> option -> mean confidence */
  confidence: Record<string, Record<string, { mean: number; n: number }>>;
  /** Of answers at confidence >= t, what share were correct. */
  calibration: { threshold: number; n: number; correct: number; rate: number }[];
  failures: {
    name?: string;
    input: unknown;
    expected: Record<string, unknown>;
    actual: Record<string, unknown>;
    nodes: Record<string, unknown>;
  }[];
  errors: string[];
}

export interface RunEvalOptions {
  spec: PipelineSpec;
  version: number;
  cases: EvalCase[];
  model?: string;
  concurrency?: number;
  /** Defaults to OpenRouter; injectable for tests. */
  provider?: Provider;
  onProgress?: (done: number, total: number, passed: number) => void | Promise<void>;
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const started = Date.now();
  const { spec, cases } = opts;
  const settings = resolveSettings(spec);
  const model = opts.model ?? settings.runtimeModel;
  const concurrency = opts.concurrency ?? 8;
  const p = opts.provider ?? provider();

  const report: EvalReport = {
    pipeline: spec.id,
    version: opts.version,
    model,
    resolved_model: model,
    cases: cases.length,
    passed: 0,
    accuracy: null,
    errored: 0,
    error_kinds: {},
    duration_ms: 0,
    key_accuracy: {},
    node_accuracy: {},
    confusion: {},
    confidence: {},
    calibration: [],
    failures: [],
    errors: [],
  };

  const confidenceSamples: { confidence: number; correct: boolean }[] = [];
  let cursor = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= cases.length) return;
      const testCase = cases[index];
      try {
        const result = await execute({
          spec,
          version: opts.version,
          input: testCase.input,
          provider: p,
          model,
          settings,
        });
        report.resolved_model = result.model;

        let casePassed = true;
        for (const [key, want] of Object.entries(testCase.expect)) {
          const got = result.output[key];
          const ok = matchesExpectation(want, got);
          const bucket = (report.key_accuracy[key] ??= { passed: 0, total: 0, accuracy: 0 });
          bucket.total++;
          if (ok) bucket.passed++;
          else casePassed = false;

          const node = nodeForOutputKey(spec, key);
          if (node) {
            const nodeBucket = (report.node_accuracy[node] ??= { passed: 0, total: 0, accuracy: 0 });
            nodeBucket.total++;
            if (ok) nodeBucket.passed++;

            // A passing case is recorded on the diagonal. Comparing the raw
            // strings here would log `true -> 0.9` as a confusion even though
            // a yes/no expectation reads a probability by threshold and the
            // case passed.
            const matrix = (report.confusion[node] ??= {});
            const expectedRow = (matrix[String(want)] ??= {});
            const actual = ok ? String(want) : String(got ?? '(none)');
            expectedRow[actual] = (expectedRow[actual] ?? 0) + 1;

            const answer = result.nodes[node];
            if (answer?.confidence !== undefined) {
              const perNode = (report.confidence[node] ??= {});
              const option = String(answer.choice ?? answer.value ?? '(none)');
              const stats = (perNode[option] ??= { mean: 0, n: 0 });
              stats.mean = (stats.mean * stats.n + answer.confidence) / (stats.n + 1);
              stats.n++;
              confidenceSamples.push({ confidence: answer.confidence, correct: ok });
            }
          }
        }

        if (casePassed) report.passed++;
        else if (report.failures.length < 200) {
          report.failures.push({
            ...(testCase.name ? { name: testCase.name } : {}),
            input: testCase.input,
            expected: testCase.expect,
            actual: result.output,
            nodes: result.nodes,
          });
        }
      } catch (err) {
        const kind = err instanceof ProblemError ? err.code : 'internal_error';
        report.errored++;
        report.error_kinds[kind] = (report.error_kinds[kind] ?? 0) + 1;
        report.errors.push(`${testCase.name ?? `case ${index}`}: ${(err as Error).message}`);
      } finally {
        done++;
        if (opts.onProgress && (done % 5 === 0 || done === cases.length)) {
          await opts.onProgress(done, cases.length, report.passed);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(cases.length, 1)) }, worker));

  const answered = cases.length - report.errored;
  report.accuracy = answered > 0 ? report.passed / answered : null;
  for (const bucket of Object.values(report.key_accuracy)) {
    bucket.accuracy = bucket.total > 0 ? bucket.passed / bucket.total : 0;
  }
  for (const bucket of Object.values(report.node_accuracy)) {
    bucket.accuracy = bucket.total > 0 ? bucket.passed / bucket.total : 0;
  }
  report.calibration = calibrationCurve(confidenceSamples);
  report.duration_ms = Date.now() - started;
  return report;
}

/**
 * "Of answers at confidence >= t, what share were correct." A well-calibrated
 * model tracks the threshold; a gap is the signal that confidence cannot be
 * trusted for routing.
 */
function calibrationCurve(samples: { confidence: number; correct: boolean }[]) {
  return [0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((threshold) => {
    const bucket = samples.filter((s) => s.confidence >= threshold);
    const correct = bucket.filter((s) => s.correct).length;
    return {
      threshold,
      n: bucket.length,
      correct,
      rate: bucket.length > 0 ? correct / bucket.length : 0,
    };
  });
}

function nodeForOutputKey(spec: PipelineSpec, key: string): string | null {
  const mapping = spec.output[key];
  if (typeof mapping !== 'string') return null;
  const first = mapping.split(/[^a-zA-Z0-9_]/)[0];
  return first in spec.nodes ? first : null;
}

/** The top confused pairs, which is what the UI and the repair pass want. */
export function topConfusions(
  report: EvalReport,
  limit = 10,
): { node: string; expected: string; actual: string; count: number }[] {
  const out: { node: string; expected: string; actual: string; count: number }[] = [];
  for (const [node, matrix] of Object.entries(report.confusion)) {
    for (const [expected, row] of Object.entries(matrix)) {
      for (const [actual, count] of Object.entries(row)) {
        if (actual !== expected) out.push({ node, expected, actual, count });
      }
    }
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit);
}

/** Persists the eval, full report included, to Postgres. */
export async function persistEval(
  report: EvalReport,
  trigger: 'manual' | 'save' | 'nightly' | 'ci' | 'compile',
): Promise<number> {
  // Nothing answered means nothing was measured. It is stored as a failed run,
  // and it moves no gauge, no version score and no drift baseline — all of
  // which would otherwise read a provider outage as the pipeline getting worse.
  const measured = report.accuracy !== null;
  const row = await repo.insertEvalRun({
    pipeline_id: report.pipeline,
    version: report.version,
    model: report.model,
    resolved_model: report.resolved_model,
    accuracy: report.accuracy,
    node_accuracy: report.node_accuracy,
    confusion: report.confusion,
    calibration: report.calibration,
    cases: report.cases,
    passed: report.passed,
    duration_ms: report.duration_ms,
    trigger,
    report,
    status: measured ? 'done' : 'failed',
    // A case that threw never reached a model. Without this, a suite that could
    // not run at all is stored as a clean 0% — indistinguishable from a model
    // that got every answer wrong, and the reason is lost with the process.
    error: report.errored
      ? `${report.errored}/${report.cases} cases could not run: ${report.errors[0]}`
      : null,
  });
  const evalId = row!.id;

  if (!measured) {
    log.warn('eval could not run a single case; recorded as failed, not as 0% accuracy', {
      pipeline: report.pipeline,
      version: report.version,
      error_kinds: report.error_kinds,
    });
    return evalId;
  }

  await repo.setVersionEvalSummary(report.pipeline, report.version, {
    accuracy: report.accuracy,
    cases: report.cases,
    passed: report.passed,
    errored: report.errored,
    resolved_model: report.resolved_model,
    at: new Date().toISOString(),
  });
  return evalId;
}

/** Test cases come from the spec and from the stored, feedback-promoted set. */
export async function collectCases(pipelineId: string, spec: PipelineSpec): Promise<EvalCase[]> {
  const stored = await repo.listTestCases(pipelineId);
  const cases: EvalCase[] = stored.map((t) => ({
    ...(t.name ? { name: t.name } : {}),
    input: t.input,
    expect: t.expected,
  }));
  if (cases.length === 0 && spec.tests) {
    return spec.tests.map((t) => ({ ...(t.name ? { name: t.name } : {}), input: t.input, expect: t.expect }));
  }
  return cases;
}
