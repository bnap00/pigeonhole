/**
 * The Laya provider: Jev's wire format over laya-serve, with fetch stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayaProvider } from '../src/provider/laya.ts';
import { provider } from '../src/provider/index.ts';

/** Captures the request and answers with a laya-serve response shaped like the real one. */
async function withLaya<T>(body: Record<string, unknown>, fn: (sent: { url: string; body: any; headers: any }[]) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const sent: { url: string; body: any; headers: any }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const response = (checkpoint: string) => ({
  model: 'laya-rl-agent',
  answers: {
    team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, other: 0.1 }, confidence: 0.81 },
    urgency: { type: 'score', score: 1.7, probabilities: { 0: 0.05, 1: 0.2, 2: 0.75 }, confidence: 0.6 },
    angry: { type: 'noul', noul: 0.8, confidence: 0.8 },
  },
  usage: { input_tokens: 120, output_tokens: 0 },
  routing: { model: checkpoint, reason: 'detected' },
});

const questions = {
  team: { type: 'choice' as const, instructions: 'Which team?', criteria: { billing: { what: 'Money', examples: ['refund', 'invoice'], not_for: 'pricing questions' }, other: 'Anything else' } },
  urgency: { type: 'score' as const, instructions: 'How urgent?', scale: { min: 1, max: 3 } },
  angry: { type: 'noul' as const, instructions: 'Is the customer angry?' },
};

test('plain `laya` lets the server pick the checkpoint and reports the one that answered', async () => {
  await withLaya(response('multilingual'), async (sent) => {
    const res = await createLayaProvider()({ model: 'laya', state: { body: 'Me cobraron dos veces' }, questions });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'http://laya:8000/v1/systemone');
    assert.equal(sent[0].body.model, undefined, 'no model: the Laya router chooses');
    assert.deepEqual(sent[0].body.state, { body: 'Me cobraron dos veces' });
    assert.equal(res.model, 'laya-multilingual');
    assert.equal(res.answers.team.choice, 'billing');
    assert.equal(res.answers.urgency.score, 3);
    assert.equal(res.answers.angry.p, 0.8);
    assert.equal(res.usage.input_tokens, 120);
    assert.equal(res.usage.cost_usd, 0);
  });
});

test('a pinned checkpoint is sent as Laya names it', async () => {
  await withLaya(response('typed-decisions'), async (sent) => {
    const res = await createLayaProvider()({ model: 'laya-typed-decisions', state: 'x', questions });
    assert.equal(sent[0].body.model, 'typed-decisions');
    assert.equal(res.model, 'laya-typed-decisions');
  });
});

test('questions go out in the wire format, with structured criteria flattened to text', async () => {
  await withLaya(response('english'), async (sent) => {
    await createLayaProvider()({ model: 'laya-english', state: 'x', questions });
    const q = sent[0].body.questions;
    assert.deepEqual(q.team.criteria, {
      billing: 'Money. e.g. refund; invoice. not for pricing questions',
      other: 'Anything else',
    });
    assert.deepEqual(q.urgency, { type: 'score', instructions: 'How urgent?', criteria: ['1', '2', '3'] });
    assert.deepEqual(q.angry, { type: 'noul', instructions: 'Is the customer angry?' });
  });
});

test('the router sends laya models to Laya and Jev to OpenRouter', async () => {
  await withLaya(response('english'), async (sent) => {
    await provider().decide({ model: 'laya', state: 'x', questions });
    assert.match(sent[0].url, /\/v1\/systemone$/);
  });
});

test('the Laya provider refuses a model that is not Laya', async () => {
  await withLaya(response('english'), async (sent) => {
    await assert.rejects(createLayaProvider()({ model: 'jev-latest', state: 'x', questions }), /not a decision model/);
    assert.equal(sent.length, 0);
  });
});
