/**
 * Classifications are answered only by decision models, through the provider
 * that serves each — never by a chat model, whose probabilities are not
 * calibrated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecYaml } from '../src/spec/parse.ts';
import { readDecisionResponse } from '../src/provider/wire.ts';

const withLowConfidence = (action: string) => `
pigeonhole: 1
id: policy-check
input: { type: object, properties: { body: { type: string } }, required: [body] }
nodes:
  topic:
    type: choice
    instructions: What is this about?
    criteria:
      billing: { what: Money }
      other: { what: Anything else }
    min_confidence: 0.5
    on_low_confidence: ${action}
output:
  topic: topic.choice
`;

test('a Decisions response is read into the executor\'s answer shape', () => {
  // The example response from OpenRouter's API reference.
  const raw = {
    answers: {
      is_bug: { type: 'noul', noul: 0.96 },
      team: { type: 'choice', choice: 'payments', confidence: 0.75, probabilities: { account: 0, frontend: 0.16, payments: 0.84 } },
      urgency: { type: 'score', score: 1.99, confidence: 0.99, probabilities: { 0: 0, 1: 0.01, 2: 0.99 } },
    },
    model: 'typesafe/jev-1.13-20260917',
    usage: { cost: 1.9992e-5, input_tokens: 476, output_tokens: 70 },
  };
  const res = readDecisionResponse(raw, {
    is_bug: { type: 'noul', instructions: 'Is it a bug?' },
    team: { type: 'choice', instructions: 'Which team?', criteria: { account: 'a', frontend: 'f', payments: 'p' } },
    urgency: { type: 'score', instructions: 'How urgent?', scale: { min: 1, max: 3 } },
  });
  assert.equal(res.answers.is_bug.p, 0.96);
  assert.ok(Math.abs(res.answers.is_bug.confidence! - 0.92) < 1e-9);
  assert.equal(res.answers.team.choice, 'payments');
  assert.equal(res.answers.team.confidence, 0.75);
  // The most likely level (index 2), mapped back onto the spec's 1..3 scale.
  assert.equal(res.answers.urgency.score, 3);
  assert.deepEqual(res.answers.urgency.probabilities, { 1: 0, 2: 0.01, 3: 0.99 });
  assert.equal(res.model, 'typesafe/jev-1.13-20260917');
  assert.equal(res.usage.cost_usd, 1.9992e-5);
  assert.throws(() => readDecisionResponse({ choices: [] }, {}), /no `answers` map/);
});

test('a spec cannot re-ask a low-confidence node through a chat model', () => {
  assert.throws(() => parseSpecYaml(withLowConfidence('fallback_model')), (err: Error & { detail?: string }) => {
    assert.match(err.detail ?? err.message, /fallback_model, which re-asks a chat model/);
    assert.match(err.detail ?? err.message, /human_review, error or default:<option>/);
    return true;
  });
});

test('the remaining low-confidence actions are unaffected', () => {
  for (const action of ['human_review', 'error', 'default:other']) {
    assert.doesNotThrow(() => parseSpecYaml(withLowConfidence(action)), action);
  }
});

// ── only decision models answer classifications ────────────────────────────

import { spawnSync } from 'node:child_process';
import { isDecisionModel } from '../src/provider/models.ts';
import { createOpenRouterProvider } from '../src/provider/openrouter.ts';
import { provider } from '../src/provider/index.ts';

test('Jev model names are decision models; chat models are not', () => {
  // Including the fully resolved name a Decisions response reports, which is
  // what a pipeline would be pinned to.
  for (const m of ['jev', 'jev-latest', 'jev-1.13.0', 'typesafe/jev-1.13', 'typesafe/jev-1.13-20260917', 'JEV-LATEST']) {
    assert.ok(isDecisionModel(m), m);
  }
  for (const m of ['openai/gpt-6-luna', 'cloudflare/clef-pro', 'openai/gpt-4o-mini', 'anthropic/claude-sonnet-5', 'jevil', 'jev-latest:free', 'my-jev', 'jev--x', '']) {
    assert.ok(!isDecisionModel(m), m);
  }
});

test('Laya model names are decision models', () => {
  for (const m of ['laya', 'laya-english', 'laya-multilingual', 'laya-typed-decisions', 'convaiinnovations/laya-multilingual', 'LAYA']) {
    assert.ok(isDecisionModel(m), m);
  }
  for (const m of ['laya-rl-agent', 'layla', 'laya-latest', 'someone/laya', 'laya-']) {
    assert.ok(!isDecisionModel(m), m);
  }
});

test('Clef and GPT-6 Luna Decisions on OpenRouter are decision models', () => {
  for (const m of ['cloudflare/clef', 'cloudflare/clef-flash', 'openai/gpt-6-luna-decisions', 'openai/gpt-6-luna-decisions-20261006']) {
    assert.ok(isDecisionModel(m), m);
  }
});

test('the provider refuses to send a chat model to the Decisions API', async () => {
  let sent = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    sent = true;
    return new Response('{}');
  }) as typeof fetch;
  try {
    await assert.rejects(
      createOpenRouterProvider().decide({ model: 'openai/gpt-4o-mini', state: 'hi', questions: {} }),
      /not a decision model/,
    );
    assert.equal(sent, false, 'the refusal happens before any request');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a question the model refuses comes back unanswered; the rest are asked again', async () => {
  const { config } = await import('../src/config.ts');
  const key = config.openrouterApiKey;
  Object.assign(config, { openrouterApiKey: 'test' });
  const realFetch = globalThis.fetch;
  const asked: string[][] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const questions = Object.keys(JSON.parse(String(init.body)).questions);
    asked.push(questions);
    if (questions.includes('first_issue')) {
      return new Response('{"error":{"message":"OpenAI refused to answer question \\"first_issue\\"","code":502}}', { status: 502 });
    }
    return new Response(JSON.stringify({
      model: 'openai/gpt-6-luna-decisions-20261006',
      answers: { kind: { type: 'choice', choice: 'bug', probabilities: { bug: 0.9, feature: 0.1 }, confidence: 0.8 } },
      usage: { input_tokens: 100, cost: 0.00001 },
    }));
  }) as typeof fetch;
  try {
    const res = await createOpenRouterProvider().decide({
      model: 'openai/gpt-6-luna-decisions',
      state: 'Crash on startup',
      questions: {
        kind: { type: 'choice', instructions: 'What kind?', criteria: { bug: 'A defect', feature: 'A request' } },
        first_issue: { type: 'noul', instructions: 'Good first issue?' },
      },
    });
    assert.equal(res.answers.kind.choice, 'bug');
    assert.equal(res.answers.first_issue, undefined);
    assert.deepEqual(asked.at(-1), ['kind']);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config, { openrouterApiKey: key });
  }
});

test('the router refuses a model no decision provider serves', async () => {
  const realFetch = globalThis.fetch;
  let sent = false;
  globalThis.fetch = (async () => {
    sent = true;
    return new Response('{}');
  }) as typeof fetch;
  try {
    await assert.rejects(
      provider().decide({ model: 'anthropic/claude-sonnet-5', state: 'hi', questions: {} }),
      /not a decision model/,
    );
    assert.equal(sent, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a spec cannot name a chat model as its runtime', () => {
  const yaml = withLowConfidence('human_review').replace('pigeonhole: 1', 'pigeonhole: 1\nmodel: { runtime: openai/gpt-4o-mini }');
  assert.throws(() => parseSpecYaml(yaml), /not a decision model/);
});

test('the app will not start with a chat model as PH_RUNTIME_MODEL', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/config.ts')"], {
    env: { ...process.env, PH_RUNTIME_MODEL: 'openai/gpt-4o-mini' },
    encoding: 'utf8',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /PH_RUNTIME_MODEL: "openai\/gpt-4o-mini" is not a decision model/);
});
