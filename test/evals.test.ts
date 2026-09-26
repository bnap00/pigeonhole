/**
 * A case that never reached the model is not evidence about the pipeline.
 * Counting it as a wrong answer turned a provider outage into "accuracy fell
 * 100 points" — a false drift alert on every pipeline, every night it lasted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEval, type EvalCase } from '../src/evals/run.ts';
import { parseSpecYaml } from '../src/spec/parse.ts';
import { problem } from '../src/errors.ts';
import type { DecisionRequest, DecisionResponse, Provider } from '../src/provider/types.ts';

const spec = parseSpecYaml(`
pigeonhole: 1
id: eval-semantics
input: { type: object, properties: { body: { type: string } }, required: [body] }
nodes:
  topic:
    type: choice
    instructions: What is this about?
    criteria: { billing: { what: Money }, other: { what: Anything else } }
output:
  topic: topic.choice
`);

const cases: EvalCase[] = ['refund please', 'hello', 'invoice wrong', 'nice day'].map((body, i) => ({
  name: `case-${i}`,
  input: { body },
  expect: { topic: /refund|invoice/.test(body) ? 'billing' : 'other' },
}));

/** Answers correctly, except for the inputs it is told to fail on. */
function provider(failOn: (body: string) => boolean): Provider {
  return {
    async decide(req: DecisionRequest): Promise<DecisionResponse> {
      const body = (req.state as { body: string }).body;
      if (failOn(body)) throw problem('provider_error', 'openrouter decisions returned 404');
      const choice = /refund|invoice/.test(body) ? 'billing' : 'other';
      return {
        answers: { topic: { choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 } },
        model: 'jev-test',
        usage: { input_tokens: 1 },
      };
    },
    async chat() { throw new Error('not used'); },
  };
}

test('when no case reaches the model there is no accuracy, not 0%', async () => {
  const report = await runEval({ spec, version: 1, cases, provider: provider(() => true), concurrency: 1 });
  assert.equal(report.accuracy, null);
  assert.equal(report.passed, 0);
  assert.equal(report.errored, 4);
  assert.deepEqual(report.error_kinds, { provider_error: 4 });
});

test('accuracy is measured on the cases that ran, and the rest are reported', async () => {
  const report = await runEval({
    spec, version: 1, cases, provider: provider((b) => b === 'hello'), concurrency: 1,
  });
  assert.equal(report.errored, 1);
  assert.equal(report.passed, 3);
  assert.equal(report.accuracy, 1, 'three answered, three right: an outage on one case is not a wrong answer');
});

test('every case running behaves exactly as before', async () => {
  const report = await runEval({ spec, version: 1, cases, provider: provider(() => false), concurrency: 1 });
  assert.equal(report.errored, 0);
  assert.equal(report.accuracy, 1);
});
