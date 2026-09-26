/**
 * Fixed-window rate limiting, per API key, per minute, held in memory. That is
 * correct for one app container; several replicas would each allow the limit.
 */
import { config } from '../config.js';
import { problem } from '../errors.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const local = new Map<string, Bucket>();

export interface RateVerdict {
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export function consume(subject: string, limit = config.rateLimitPerMinute): RateVerdict {
  if (limit <= 0) return { limit: 0, remaining: 0, resetSeconds: 60 };
  const window = Math.floor(Date.now() / 60_000);
  const key = `${subject}:${window}`;

  let count: number;
  const bucket = local.get(key);
  if (bucket) {
    bucket.count++;
    count = bucket.count;
  } else {
    local.set(key, { count: 1, resetAt: (window + 1) * 60_000 });
    count = 1;
    if (local.size > 10_000) {
      for (const [k, v] of local) if (v.resetAt < Date.now()) local.delete(k);
    }
  }

  const resetSeconds = 60 - Math.floor((Date.now() % 60_000) / 1000);
  if (count > limit) {
    throw problem('rate_limited', `rate limit of ${limit} requests per minute exceeded`, {
      limit,
      retry_after_seconds: resetSeconds,
    });
  }
  return { limit, remaining: Math.max(0, limit - count), resetSeconds };
}

export function clearRateLimits(): void {
  local.clear();
}
