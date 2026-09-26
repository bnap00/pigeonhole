/**
 * Whether the model provider can actually answer. Read by `make check`
 * (GET /v1/check).
 */
import { config } from '../config.js';
import { provider } from '../provider/index.js';

export type CheckState = 'ok' | 'warn' | 'fail';
export interface Check { name: string; state: CheckState; detail: string; fix?: string }

/**
 * One real, minimal classification through the same `decide()` path live
 * traffic uses. A configuration check says a key exists; this says classify
 * works. It costs a fraction of a cent, so the result is reused for a few
 * minutes to keep a monitor polling `/v1/check` from spending money.
 */
const PROBE_TTL_MS = 5 * 60_000;
let lastProbe: { at: number; check: Check } | null = null;

export async function providerCheck(): Promise<Check> {
  if (lastProbe && Date.now() - lastProbe.at < PROBE_TTL_MS) return lastProbe.check;
  const name = 'provider';
  let check: Check;
  if (!config.openrouterApiKey) {
    check = { name, state: 'fail', detail: 'OPENROUTER_API_KEY is empty', fix: 'set it in .env, then make up' };
  } else {
    const started = Date.now();
    try {
      const res = await provider().decide({
        model: config.defaultRuntimeModel,
        state: 'Hello there!',
        questions: { probe: { type: 'noul', instructions: 'The text is a greeting.' } },
        timeoutMs: 15_000,
      });
      check = { name, state: 'ok', detail: `${res.model} answered in ${Date.now() - started}ms` };
    } catch (err) {
      const e = err as { detail?: string; message?: string; extra?: { provider_status?: number } };
      const status = e.extra?.provider_status;
      check = {
        name,
        state: 'fail',
        detail: `a test classification failed: ${e.detail ?? e.message}`,
        fix:
          status === 401 || status === 403
            ? 'OpenRouter rejected the key; check OPENROUTER_API_KEY in .env'
            : status === 402
              ? 'the OpenRouter account is out of credit'
              : status === 400 || status === 404
                ? `OpenRouter does not serve "${config.defaultRuntimeModel}"; set PH_RUNTIME_MODEL to jev-latest or a pinned version like typesafe/jev-1.13`
                : 'see docs/troubleshooting.md',
      };
    }
  }
  lastProbe = { at: Date.now(), check };
  return check;
}
