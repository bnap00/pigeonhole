/**
 * The Laya client: a self-hosted decision model (https://www.layaaimodel.com),
 * reached through `laya-serve`.
 *
 * `laya-serve` speaks Jev's wire format on `POST /v1/systemone`, so the
 * questions and answers are the same as OpenRouter's Decisions API and only
 * the transport differs. Laya's probabilities are trained against proper
 * scoring rules, which is what makes it a decision model here.
 *
 * Model ids: `laya` lets the server pick a checkpoint per request (English, or
 * multilingual for anything else); `laya-english`, `laya-multilingual` and
 * `laya-typed-decisions` pin one. The resolved model is the checkpoint that
 * answered, so evals and drift see which one it was.
 */
import { config } from '../config.js';
import { decisionProviderFor, notADecisionModel } from './models.js';
import { problem } from '../errors.js';
import { postJson } from './http.js';
import { readDecisionResponse, toWire } from './wire.js';
import type { DecisionQuestion, DecisionRequest, DecisionResponse, Provider } from './types.js';

/**
 * A preloaded checkpoint answers in tens of milliseconds on a GPU and a few
 * hundred per question on a CPU. The headroom is for a checkpoint the server
 * has not built yet, which it does on the first request that needs it.
 */
const DECISION_TIMEOUT_MS = 30_000;

const CHECKPOINTS = ['english', 'multilingual', 'typed-decisions'];

/** `laya-multilingual` → `multilingual`; plain `laya` → undefined, so the server routes. */
function checkpointOf(model: string): string | undefined {
  const m = model.trim().toLowerCase().match(/^(?:convaiinnovations\/)?laya-(.+)$/);
  return m ? m[1] : undefined;
}

/**
 * A spec's structured criterion (`what`, `examples`, `not_for`) as one line.
 * Laya fits every option into a small token budget and would otherwise read
 * the criterion as JSON, braces and all.
 */
function criterionText(c: unknown): unknown {
  if (!c || typeof c !== 'object') return c;
  if (Array.isArray(c)) return c.join('; ');
  const { what, examples, not_for } = c as { what?: unknown; examples?: unknown; not_for?: unknown };
  const parts = [
    what ? String(what) : '',
    Array.isArray(examples) && examples.length ? `e.g. ${examples.join('; ')}` : '',
    not_for ? `not for ${String(not_for)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('. ') : JSON.stringify(c);
}

function layaQuestions(questions: Record<string, DecisionQuestion>): Record<string, DecisionQuestion> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [
      id,
      q.type === 'choice' && q.criteria
        ? { ...q, criteria: Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, criterionText(v)])) }
        : q,
    ]),
  );
}

export function createLayaProvider(): Provider['decide'] {
  return async function decide(req: DecisionRequest): Promise<DecisionResponse> {
    if (decisionProviderFor(req.model) !== 'laya') {
      throw problem('input_invalid', notADecisionModel(req.model));
    }
    const checkpoint = checkpointOf(req.model);
    const raw = await postJson<Record<string, unknown>>({
      url: `${config.layaUrl}/v1/systemone`,
      label: 'laya',
      headers: config.layaApiKey ? { authorization: `Bearer ${config.layaApiKey}` } : {},
      timeoutMs: req.timeoutMs ?? DECISION_TIMEOUT_MS,
      maxRetries: 1,
      body: {
        ...(checkpoint ? { model: checkpoint } : {}),
        state: req.state,
        questions: toWire(layaQuestions(req.questions)),
      },
    });
    // The body's `model` is always "laya-rl-agent"; `routing` says which checkpoint answered.
    const routed = (raw.routing as { model?: unknown } | undefined)?.model;
    const answered = typeof routed === 'string' && CHECKPOINTS.includes(routed) ? routed : checkpoint;
    return readDecisionResponse(
      { ...raw, model: answered ? `laya-${answered}` : req.model, usage: { ...(raw.usage as object), cost: 0 } },
      req.questions,
    );
  };
}
