/**
 * The decision wire format: Jev's `choice` / `score` / `noul` questions and the
 * answers map that comes back. OpenRouter's Decisions API and Laya's
 * `laya-serve` (`POST /v1/systemone`) both speak it, so every decision provider
 * shares these.
 */
import { problem } from '../errors.js';
import type { DecisionAnswer, DecisionQuestion, DecisionResponse } from './types.js';

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

function questionToWire(q: DecisionQuestion): Record<string, unknown> {
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

export function toWire(questions: Record<string, DecisionQuestion>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, questionToWire(q)]));
}
