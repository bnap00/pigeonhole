/**
 * A deterministic, offline stand-in for OpenRouter, for the tests only.
 *
 * It scores options by lexical overlap between the input and each option's
 * criteria, then softmaxes, so answers are plausible and stable rather than
 * random. It is not Jev: the model name says `fake`.
 */
import { createHash } from 'node:crypto';
import type { ChatRequest, ChatResponse, DecisionAnswer, DecisionQuestion, DecisionRequest, DecisionResponse, Provider } from '../src/provider/types.ts';

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'is', 'it', 'this', 'that',
  'with', 'my', 'i', 'you', 'we', 'was', 'were', 'be', 'been', 'are', 'not', 'no', 'at', 'as',
  'but', 'if', 'so', 'do', 'did', 'have', 'has', 'had', 'can', 'will', 'would', 'about',
]);

const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

function criterionText(option: string, criterion: unknown): string {
  const parts = [option.replace(/[_-]/g, ' ')];
  if (typeof criterion === 'string') parts.push(criterion);
  else if (Array.isArray(criterion)) parts.push(criterion.join(' '));
  else if (criterion && typeof criterion === 'object') {
    const c = criterion as Record<string, unknown>;
    if (c.what) parts.push(String(c.what));
    if (Array.isArray(c.examples)) parts.push(c.examples.map(String).join(' '));
  }
  return parts.join(' ');
}

function negativeText(criterion: unknown): string {
  if (criterion && typeof criterion === 'object' && !Array.isArray(criterion)) {
    const c = criterion as Record<string, unknown>;
    if (c.not_for) return String(c.not_for);
  }
  return '';
}

/** Stable pseudo-random in [0,1) from a string, so the same input always scores the same. */
function seeded(key: string): number {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 0xffffffff;
}

function softmax(scores: number[], temperature = 0.55): number[] {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

function answerQuestion(id: string, q: DecisionQuestion, stateText: string): DecisionAnswer {
  const inputWords = new Set(words(stateText));

  if (q.type === 'choice') {
    const options = Object.keys(q.criteria ?? {});
    const scores = options.map((option) => {
      const criterion = q.criteria?.[option];
      const positive = words(criterionText(option, criterion));
      const negative = words(negativeText(criterion));
      let score = 0;
      for (const w of new Set(positive)) if (inputWords.has(w)) score += 1;
      for (const w of new Set(negative)) if (inputWords.has(w)) score -= 0.8;
      // Catch-alls only win when nothing else matches.
      if (/^(other|none|unknown|unclear)$/i.test(option)) score -= 0.35;
      // A small stable nudge breaks ties without making answers random.
      return score + seeded(`${id}:${option}:${stateText}`) * 0.25;
    });
    const probs = softmax(scores);
    const entries = options.map((o, i) => [o, probs[i]] as const).sort((a, b) => b[1] - a[1]);
    return {
      choice: entries[0][0],
      confidence: round(entries[0][1]),
      probabilities: Object.fromEntries(options.map((o, i) => [o, round(probs[i])])),
    };
  }

  if (q.type === 'noul') {
    const cue = words(q.instructions);
    const hits = cue.filter((w) => inputWords.has(w)).length;
    const p = clamp(0.12 + hits * 0.22 + seeded(`${id}:${stateText}`) * 0.2);
    return { p: round(p), confidence: round(Math.abs(p - 0.5) * 2) };
  }

  const min = q.scale?.min ?? 0;
  const max = q.scale?.max ?? 1;
  const cue = words(q.instructions);
  const hits = cue.filter((w) => inputWords.has(w)).length;
  const t = clamp(0.3 + hits * 0.18 + seeded(`${id}:score:${stateText}`) * 0.25);
  const raw = min + t * (max - min);
  const step = Number.isInteger(min) && Number.isInteger(max) ? Math.round(raw) : round(raw);
  return { score: step, confidence: round(0.6 + seeded(`${id}:conf:${stateText}`) * 0.3) };
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number) => Math.round(n * 1000) / 1000;

export function createFakeProvider(): Provider {
  return {
    async decide(req: DecisionRequest): Promise<DecisionResponse> {
      const stateText = typeof req.state === 'string' ? req.state : JSON.stringify(req.state);
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        answers[id] = answerQuestion(id, q, stateText);
      }
      // A touch of latency so timing-sensitive UI and metrics look realistic.
      await new Promise((r) => setTimeout(r, 4 + Math.floor(seeded(stateText) * 12)));
      return {
        answers,
        model: 'fake-1.0.0',
        usage: { input_tokens: Math.ceil(stateText.length / 4), output_tokens: 0, cost_usd: 0 },
      };
    },

    async chat(req: ChatRequest): Promise<ChatResponse> {
      // Synthesizes a value that satisfies the requested JSON schema. The
      // content is trivial but structurally valid, which is what makes the
      // compiler's passes and the SSE progress stream testable offline.
      const value = req.schema ? synthesize(req.schema.schema, seeded(req.messages.map((m) => m.content).join())) : null;
      const text = req.schema ? JSON.stringify(value) : 'mock response';
      return {
        text,
        json: req.schema ? value : undefined,
        model: 'fake-chat-1.0.0',
        usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: 0, cost_usd: 0 },
      };
    },
  };
}


/**
 * Builds the smallest value that satisfies a JSON schema. It understands the
 * subset the compiler's own schemas use.
 */
function synthesize(schema: Record<string, unknown>, rand: number, key = ''): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      // Every property is populated, including optional ones: a draft that
      // omits a choice node's `options` is not a usable pipeline, and the
      // point of this provider is to exercise the real code paths.
      const out: Record<string, unknown> = {};
      for (const name of Object.keys(properties)) {
        out[name] = synthesize(properties[name], rand, name);
      }
      return out;
    }
    case 'array': {
      // A choice node needs at least two options and a catch-all to be worth
      // compiling, so the mock produces a usable set rather than one item.
      if (key === 'options') return ['first', 'second', 'other'];
      const min = Math.max(1, Number(schema.minItems ?? 1));
      const items = (schema.items ?? {}) as Record<string, unknown>;
      return Array.from({ length: min }, (_, i) => synthesize(items, (rand + i * 0.17) % 1, key));
    }
    case 'number':
    case 'integer': {
      const min = Number(schema.minimum ?? 0);
      const max = Number(schema.maximum ?? min + 1);
      const value = min + (max - min) * rand;
      return type === 'integer' ? Math.round(value) : round(value);
    }
    case 'boolean':
      return rand > 0.5;
    case 'null':
      return null;
    default:
      return mockString(key);
  }
}

function mockString(key: string): string {
  switch (key) {
    case 'id': return 'mock_node';
    case 'name': return 'mock';
    case 'instructions': return 'A question generated by the fake provider.';
    case 'when': return '';
    case 'on_low_confidence': return 'human_review';
    case 'key': return 'result';
    case 'description': return 'A mock input field.';
    case 'purpose': return 'Mock decision.';
    case 'type': return 'choice';
    case 'expr': return '"mock"';
    case 'what': return 'Definition written by the fake provider.';
    case 'not_for': return 'Exclusion written by the fake provider.';
    case 'spec_yaml': return 'pigeonhole: 1\nid: mock\nnodes:\n  mock_node:\n    type: noul\n    instructions: A mock question.\noutput:\n  result: mock_node.p\n';
    default: return `mock ${key || 'value'}`;
  }
}
