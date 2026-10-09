/**
 * Shared HTTP behaviour for provider calls: timeout, one jittered retry on 5xx
 * and 429, and a concurrency ceiling.
 *
 * Node's global fetch keeps connections alive per origin, so the app reuses a
 * warm TLS connection to OpenRouter across requests.
 */
import { problem } from '../errors.js';
import { log } from '../log.js';

class Semaphore {
  private permits: number;
  private readonly waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits);
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.permits++;
  }
}

/** At most this many provider calls in flight per process. */
const gate = new Semaphore(8);

export interface FetchOptions {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  timeoutMs: number;
  /** Retries on 5xx, 429 and timeouts. */
  maxRetries: number;
  label: string;
}

const jitter = (attempt: number) => Math.round((2 ** attempt * 120) * (0.5 + Math.random()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postJson<T>(opts: FetchOptions): Promise<T> {
  const { maxRetries } = opts;
  const release = await gate.acquire();
  try {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const started = Date.now();
      try {
        const res = await fetch(opts.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...opts.headers },
          body: JSON.stringify(opts.body),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        if (res.ok) return (await res.json()) as T;

        const text = await res.text().catch(() => '');
        // 4xx other than 429 is our bug or the caller's; retrying cannot help.
        // Nor can it for a model that refused a question, which OpenRouter
        // reports as a 502.
        if ((res.status < 500 && res.status !== 429) || /refused to answer/.test(text)) {
          throw problem('provider_error', `${opts.label} returned ${res.status}: ${truncate(text)}`, {
            provider_status: res.status,
          });
        }
        lastError = new Error(`${opts.label} returned ${res.status}: ${truncate(text)}`);
      } catch (err) {
        if (err instanceof Error && err.name === 'ProblemError') throw err;
        const e = err as Error;
        lastError = e.name === 'TimeoutError' || e.name === 'AbortError'
          ? new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`)
          : e;
      }
      if (attempt < maxRetries) {
        const delay = jitter(attempt);
        log.warn('provider call failed, retrying', {
          label: opts.label,
          attempt: attempt + 1,
          delay_ms: delay,
          elapsed_ms: Date.now() - started,
          error: lastError?.message,
        });
        await sleep(delay);
      }
    }
    throw problem('provider_error', lastError?.message ?? `${opts.label} failed`, {
      retries: maxRetries,
    });
  } finally {
    release();
  }
}

const truncate = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);
