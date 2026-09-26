/**
 * The in-process spec cache.
 *
 * A published spec is loaded once and then served from a plain Map, so in
 * steady state loading the spec for a classify request costs no I/O.
 * Invalidation arrives over the bus the moment a version is published, so
 * there is no TTL to tune.
 */
import { resolveSettings, type ResolvedSettings } from '../spec/parse.js';
import type { PipelineSpec } from '../spec/types.js';
import { resolveServingVersion } from '../db/repo.js';
import { onBus, publishBus } from './bus.js';
import { log } from '../log.js';

export interface CachedSpec {
  spec: PipelineSpec;
  version: number;
  settings: ResolvedSettings;
  loadedAt: number;
}

/** key: `${pipeline}` for the serving version, `${pipeline}@${n}` for a pin. */
const cache = new Map<string, CachedSpec>();
const inflight = new Map<string, Promise<CachedSpec>>();
let wired = false;

let hits = 0;
let misses = 0;

export function specCacheStats() {
  return { entries: cache.size, hits, misses };
}

function wire(): void {
  if (wired) return;
  wired = true;
  onBus((msg) => {
    if (msg.type === 'spec_published' || msg.type === 'spec_changed') {
      // Drop the serving entry; pinned entries are immutable and stay valid.
      cache.delete(msg.pipeline);
      log.debug('spec cache invalidated', { pipeline: msg.pipeline });
    }
  });
}

export async function loadSpec(pipelineId: string, version?: number | null): Promise<CachedSpec> {
  wire();
  const key = version ? `${pipelineId}@${version}` : pipelineId;
  const hit = cache.get(key);
  if (hit) {
    hits++;
    return hit;
  }
  // Collapse a thundering herd after an invalidation into one database read.
  const pending = inflight.get(key);
  if (pending) return pending;

  misses++;
  const promise = (async () => {
    const row = await resolveServingVersion(pipelineId, version ?? null);
    const entry: CachedSpec = {
      spec: row.spec,
      version: row.version,
      settings: resolveSettings(row.spec),
      loadedAt: Date.now(),
    };
    cache.set(key, entry);
    return entry;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/** Called after publishing. Clears locally and tells every other process. */
export async function invalidateSpec(pipelineId: string, version?: number): Promise<void> {
  cache.delete(pipelineId);
  await publishBus(
    version === undefined
      ? { type: 'spec_changed', pipeline: pipelineId }
      : { type: 'spec_published', pipeline: pipelineId, version },
  );
}

export function clearSpecCache(): void {
  cache.clear();
}
