/**
 * The OpenRouter client.
 *
 * - `decide` asks Jev, through OpenRouter's Decisions API
 *   (https://openrouter.ai/docs/guides/community/jev), to answer a batch of
 *   questions about one input. Jev's probabilities are calibrated, and every
 *   threshold, review rule and drift alert here relies on that.
 * - `chat` reaches a reasoning model through chat completions. Only the
 *   compiler uses it, to write specs; it never answers a classification.
 *
 * The Decisions API is not chat-completions shaped, so this speaks it directly
 * rather than through an SDK or a proxy.
 */
import { config } from '../config.js';
import { decisionProviderFor, notADecisionModel } from './models.js';
import { problem } from '../errors.js';
import { postJson } from './http.js';
import type { ChatRequest, ChatResponse, DecisionAnswer, DecisionQuestion, DecisionRequest, DecisionResponse, Provider } from './types.js';

const BASE_URL = 'https://openrouter.ai/api/v1';
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
/** Jev answers in ~350ms warm; the first call also pays the TLS handshake. */
const DECISION_TIMEOUT_MS = 5000;

/** Attribution headers, which is how OpenRouter's app rankings see the project. */
function headers(): Record<string, string> {
  if (!config.openrouterApiKey) throw problem('provider_error', 'OPENROUTER_API_KEY is not set');
  return {
    authorization: `Bearer ${config.openrouterApiKey}`,
    'HTTP-Referer': 'https://pigeonhole.dev',
    'X-Title': 'Pigeonhole',
  };
}

export function createOpenRouterProvider(): Provider {
  return {
    async decide(req: DecisionRequest): Promise<DecisionResponse> {
      // The last line of the decision-models-only rule, covering every caller:
      // live traffic, evals, compare, shadow runs and model overrides alike.
      if (decisionProviderFor(req.model) !== 'openrouter') {
        throw problem('input_invalid', notADecisionModel(req.model));
      }
      const raw = await postJson<Record<string, unknown>>({
        url: DECISIONS_URL,
        label: 'openrouter decisions',
        headers: headers(),
        timeoutMs: req.timeoutMs ?? DECISION_TIMEOUT_MS,
        maxRetries: 1,
        body: {
          model: req.model,
          state: req.state,
          questions: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, toWire(q)])),
        },
      });
      return readDecisionResponse(raw, req.questions);
    },

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const raw = await postJson<any>({
        url: `${BASE_URL}/chat/completions`,
        label: 'openrouter chat',
        headers: headers(),
        timeoutMs: req.timeoutMs ?? 120_000,
        maxRetries: 2,
        body: {
          model: req.model,
          messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages],
          temperature: req.temperature ?? 0.2,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          ...(req.schema
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema },
                },
              }
            : {}),
        },
      });
      const text = raw?.choices?.[0]?.message?.content ?? '';
      return {
        text,
        json: req.schema ? parseJson(text) : undefined,
        model: raw?.model ?? req.model,
        usage: {
          input_tokens: raw?.usage?.prompt_tokens ?? 0,
          output_tokens: raw?.usage?.completion_tokens ?? 0,
          cost_usd: typeof raw?.usage?.cost === 'number' ? raw.usage.cost : undefined,
        },
      };
    },
  };
}

/**
 * A score question's scale, as Jev's ordered levels: one per integer from
 * `min` to `max`, described by its label when the spec gives one.
 */
function levelsOf(q: DecisionQuestion): number[] {
  const { min, max } = q.scale ?? { min: 0, max: 1 };
  const levels: number[] = [];
  for (let v = Math.ceil(min); v <= max; v++) levels.push(v);
  if (levels.length < 2 || levels.length > 50) {
    throw problem('spec_invalid', `a score scale needs 2 to 50 integer levels; ${min}..${max} has ${levels.length}`);
  }
  return levels;
}

function toWire(q: DecisionQuestion): Record<string, unknown> {
  if (q.type === 'score') {
    const levels = levelsOf(q).map((v) => q.scale?.labels?.[String(v)] ?? String(v));
    return { type: 'score', instructions: q.instructions, criteria: levels };
  }
  if (q.type === 'noul') return { type: 'noul', instructions: q.instructions };
  return { type: 'choice', instructions: q.instructions, criteria: q.criteria ?? {} };
}

/**
 * Reads a Decisions response into the executor's answer shape.
 *
 * - noul: `noul` is P(yes). Its confidence is the distance from 0.5, doubled.
 * - score: Jev returns a probability-weighted position over 0-based levels.
 *   Specs and their rules treat a scale as discrete (`urgency.score >= 2`),
 *   so the answer is the most likely level, mapped back onto the spec's scale.
 */
export function readDecisionResponse(raw: Record<string, unknown>, questions: Record<string, DecisionQuestion>): DecisionResponse {
  const answers = raw.answers as Record<string, Record<string, any>> | undefined;
  if (!answers || typeof answers !== 'object') {
    throw problem('provider_error', 'provider response contained no `answers` map', {
      received_keys: Object.keys(raw ?? {}),
    });
  }
  const out: Record<string, DecisionAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!a) continue;
    if (q.type === 'noul') {
      out[id] = { p: a.noul, confidence: Math.abs(a.noul - 0.5) * 2 };
    } else if (q.type === 'score') {
      const levels = levelsOf(q);
      const probs = (a.probabilities ?? {}) as Record<string, number>;
      const best = Object.entries(probs).sort((x, y) => y[1] - x[1])[0];
      const index = best ? Number(best[0]) : Math.round(a.score);
      out[id] = {
        score: levels[Math.min(Math.max(index, 0), levels.length - 1)],
        confidence: a.confidence,
        probabilities: Object.fromEntries(Object.entries(probs).map(([i, p]) => [String(levels[Number(i)]), p])),
      };
    } else {
      out[id] = { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
    }
  }
  const usage = (raw.usage ?? {}) as Record<string, number>;
  return {
    answers: out,
    model: String(raw.model),
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      ...(typeof usage.cost === 'number' ? { cost_usd: usage.cost } : {}),
    },
  };
}

export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Models occasionally wrap JSON in a fenced block despite json_schema mode.
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try { return JSON.parse(fence[1]); } catch { /* fall through */ }
    }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* fall through */ }
    }
    throw problem('provider_error', 'model returned text that is not valid JSON');
  }
}
