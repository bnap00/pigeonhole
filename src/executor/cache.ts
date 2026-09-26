/**
 * The optional answer cache, keyed by (spec version, input hash).
 *
 * Off by default, because decision models are cheap enough that caching is rarely the right
 * first move. Turned on per pipeline with `compose.cache.mode: memory`. It is
 * per process and lost on restart, which is all a single app container needs.
 */
import { createHash } from 'node:crypto';
import type { RunResult } from './types.js';

const MAX_ENTRIES = 5000;
const memory = new Map<string, { value: RunResult; expires: number }>();

export const cacheKey = (pipeline: string, version: number, input: unknown): string =>
  `${pipeline}:${version}:${createHash('sha256')
    .update(typeof input === 'string' ? input : JSON.stringify(input))
    .digest('hex')
    .slice(0, 32)}`;

export function readCache(key: string): RunResult | null {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value;
}

export function writeCache(key: string, value: RunResult, ttlSeconds: number): void {
  if (memory.size >= MAX_ENTRIES) {
    // Cheap eviction: drop the oldest insertion, which Map preserves.
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
  memory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

export function clearAnswerCache(): void {
  memory.clear();
}
