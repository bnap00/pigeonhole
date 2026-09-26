/**
 * One classify request, end to end.
 *
 * Everything that is not the answer itself — telemetry, run persistence,
 * shadow comparison — happens after the response is composed, so none of it
 * is on the caller's latency path.
 */
import { loadSpec } from '../cache/specs.js';
import { execute, newRunId } from '../executor/execute.js';
import { cacheKey, readCache, writeCache } from '../executor/cache.js';
import type { RunResult } from '../executor/types.js';
import { provider } from '../provider/index.js';
import { inputForStorage, recordRun, retainReason } from '../analytics/index.js';
import { insertRun } from '../db/repo.js';
import { enqueue } from '../queue/index.js';
import { log } from '../log.js';
import { ProblemError } from '../errors.js';

export interface ClassifyOptions {
  pipelineId: string;
  version?: number | null;
  input: unknown;
  /** `output` drops the per-node detail from the response. */
  detail?: 'full' | 'output';
  /** Shadow runs are compared against the live answer rather than returned. */
  shadow?: boolean;
  runId?: string;
}

export async function classify(opts: ClassifyOptions): Promise<RunResult> {
  const { spec, version, settings } = await loadSpec(opts.pipelineId, opts.version);

  const key = cacheKey(opts.pipelineId, version, opts.input);
  const cached = settings.cache ? readCache(key) : null;
  if (cached) {
    return { ...cached, run_id: opts.runId ?? newRunId(), cached: true };
  }

  const result = await execute({
    spec,
    version,
    input: opts.input,
    provider: provider(),
    settings,
    ...(opts.runId ? { runId: opts.runId } : {}),
  });

  if (settings.cache) writeCache(key, result, settings.cacheTtl);

  // Fire-and-forget: telemetry and persistence never block the response.
  void afterRun(result, settings, opts).catch((err) =>
    log.warn('post-run work failed', { run_id: result.run_id, error: (err as Error).message }),
  );

  if (opts.detail === 'output') {
    return { ...result, nodes: {} };
  }
  return result;
}

async function afterRun(
  result: RunResult,
  settings: Awaited<ReturnType<typeof loadSpec>>['settings'],
  opts: ClassifyOptions,
): Promise<void> {
  recordRun(result, settings);

  const reason = retainReason(result, settings);
  if (reason) {
    await insertRun({
      result,
      input: inputForStorage(opts.input, settings),
      retainReason: reason,
    });
  }

  // Shadow mode: the draft's answer is computed on a worker, so it competes
  // with nothing on the request path.
  if (!opts.shadow && settings.telemetry) {
    const shadowOn = await shadowEnabled(opts.pipelineId);
    if (shadowOn) {
      await enqueue('shadow', {
        pipeline: opts.pipelineId,
        run_id: result.run_id,
        live_version: result.version,
        live_output: result.output,
        input: opts.input,
      });
    }
  }
}

/** Shadow mode is a per-pipeline flag held in `meta`. */
const shadowCache = new Map<string, { value: boolean; expires: number }>();

async function shadowEnabled(pipelineId: string): Promise<boolean> {
  const hit = shadowCache.get(pipelineId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const { getMeta } = await import('../db/repo.js');
  const value = Boolean(await getMeta<boolean>(`shadow:${pipelineId}`));
  shadowCache.set(pipelineId, { value, expires: Date.now() + 30_000 });
  return value;
}

export function clearShadowCache(): void {
  shadowCache.clear();
}

const BATCH_CONCURRENCY = 8;

/**
 * Batch classification with a concurrency limit and backpressure.
 *
 * There is no subrequest cap to respect here, so the batch size is unbounded;
 * the limit is the caller's patience and the provider's rate limit, both of
 * which the concurrency ceiling manages.
 */
export async function classifyBatch(
  pipelineId: string,
  inputs: unknown[],
  version?: number | null,
  detail?: 'full' | 'output',
): Promise<{ results: (RunResult | { error: unknown })[]; ok: number; failed: number }> {
  const results: (RunResult | { error: unknown })[] = new Array(inputs.length);
  let cursor = 0;
  let ok = 0;
  let failed = 0;

  const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, inputs.length || 1) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= inputs.length) return;
      try {
        results[index] = await classify({ pipelineId, version, input: inputs[index], detail });
        ok++;
      } catch (err) {
        failed++;
        results[index] = {
          error:
            err instanceof ProblemError
              ? err.toProblem()
              : { code: 'internal_error', detail: (err as Error).message },
        };
      }
    }
  });

  await Promise.all(workers);
  return { results, ok, failed };
}
