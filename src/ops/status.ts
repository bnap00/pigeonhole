/**
 * Whether the model provider can actually answer. Read by `make check`
 * (GET /v1/check).
 */
import { config } from '../config.js';
import { provider } from '../provider/index.js';
import { decisionProviderFor } from '../provider/models.js';

export type CheckState = 'ok' | 'warn' | 'fail';
export interface Check { name: string; state: CheckState; detail: string; fix?: string }

/**
 * One real, minimal classification through the same `decide()` path live
 * traffic uses. A configuration check says a key exists; this says classify
 * works. It costs a fraction of a cent, so the result is reused for a few
 * minutes to keep a monitor polling `/v1/check` from spending money. Laya is
 * free to call, but the same reuse keeps a probe off a busy CPU.
 */
const PROBE_TTL_MS = 5 * 60_000;
let lastProbe: { at: number; check: Check } | null = null;

export async function providerCheck(): Promise<Check> {
  if (lastProbe && Date.now() - lastProbe.at < PROBE_TTL_MS) return lastProbe.check;
  const name = 'provider';
  const model = config.defaultRuntimeModel;
  const laya = decisionProviderFor(model) === 'laya';
  let check: Check;
  if (!laya && !config.openrouterApiKey) {
    check = { name, state: 'fail', detail: 'OPENROUTER_API_KEY is empty', fix: 'set it in .env, then make up' };
  } else {
    const started = Date.now();
    try {
      const res = await provider().decide({
        model,
        state: 'Hello there!',
        questions: { probe: { type: 'noul', instructions: 'The text is a greeting.' } },
        timeoutMs: laya ? 60_000 : 15_000,
      });
      check = { name, state: 'ok', detail: `${res.model} answered in ${Date.now() - started}ms` };
    } catch (err) {
      const e = err as { detail?: string; message?: string; extra?: { provider_status?: number } };
      const status = e.extra?.provider_status;
      check = {
        name,
        state: 'fail',
        detail: `a test classification failed: ${e.detail ?? e.message}`,
        fix: laya ? layaFix(status) : openRouterFix(status),
      };
    }
  }
  lastProbe = { at: Date.now(), check };
  return check;
}

function openRouterFix(status: number | undefined): string {
  if (status === 401 || status === 403) return 'OpenRouter rejected the key; check OPENROUTER_API_KEY in .env';
  if (status === 402) return 'the OpenRouter account is out of credit';
  if (status === 400 || status === 404) {
    return `OpenRouter does not serve "${config.defaultRuntimeModel}"; set PH_RUNTIME_MODEL to jev-latest or a pinned version like typesafe/jev-1.13`;
  }
  return 'see docs/troubleshooting.md';
}

function layaFix(status: number | undefined): string {
  if (status === 401) return 'the Laya server wants a key; set LAYA_API_KEY in .env to match it';
  if (status === undefined) {
    return `is the Laya server up at ${config.layaUrl}? Set COMPOSE_PROFILES=laya in .env, make up, and watch make logs while it downloads its checkpoints (docs/laya.md)`;
  }
  return 'see docs/laya.md';
}
