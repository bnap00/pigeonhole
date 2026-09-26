/**
 * The executor, driven by a stub provider so the assertions are about
 * execution semantics rather than about what a model happens to say.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/executor/execute.ts';
import { parseSpecYaml } from '../src/spec/parse.ts';
import type { DecisionRequest, DecisionResponse, Provider } from '../src/provider/types.ts';

function stub(answers: Record<string, unknown>): Provider & { calls: DecisionRequest[] } {
  const calls: DecisionRequest[] = [];
  return {
    calls,
    async decide(req: DecisionRequest): Promise<DecisionResponse> {
      calls.push(req);
      const picked: Record<string, any> = {};
      for (const id of Object.keys(req.questions)) {
        if (answers[id] !== undefined) picked[id] = answers[id];
      }
      return { answers: picked, model: 'stub-1.0.0', usage: { input_tokens: 10, output_tokens: 0 } };
    },
    async chat() {
      throw new Error('not used');
    },
  } as Provider & { calls: DecisionRequest[] };
}

const SPEC = parseSpecYaml(`
pigeonhole: 1
id: t
input:
  type: object
  properties: { body: { type: string } }
  required: [body]
nodes:
  department:
    type: choice
    instructions: Which team?
    criteria: { returns: null, billing: null, other: null }
    min_confidence: 0.5
    on_low_confidence: human_review
    also_above: 0.2
  reason:
    type: choice
    when: department == "returns"
    instructions: Why?
    criteria: { wrong_size: null, damaged: null, other: null }
  angry:
    type: noul
    instructions: Is the customer angry?
  priority:
    type: rule
    expr: 'angry.p > 0.7 ? "high" : "normal"'
output:
  team: department.choice
  reason: reason.choice
  priority: priority.value
  needs_review: department.low_confidence
  also: department.also
`);

test('one layer means exactly one provider call, with every model node in it', async () => {
  const provider = stub({
    department: { choice: 'returns', confidence: 0.9, probabilities: { returns: 0.7, billing: 0.25, other: 0.05 } },
    reason: { choice: 'wrong_size', confidence: 0.8 },
    angry: { p: 0.1 },
  });
  const result = await execute({ spec: SPEC, version: 1, input: { body: 'x' }, provider });

  assert.equal(provider.calls.length, 1);
  assert.deepEqual(Object.keys(provider.calls[0].questions).sort(), ['angry', 'department', 'reason']);
  assert.equal(result.usage.decision_calls, 1);
  assert.equal(result.output.team, 'returns');
  assert.equal(result.output.reason, 'wrong_size');
  assert.equal(result.output.priority, 'normal');
});

test('a false gate nulls the answer in the output but the node was still asked', async () => {
  const provider = stub({
    department: { choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, returns: 0.05, other: 0.05 } },
    reason: { choice: 'wrong_size', confidence: 0.8 },
    angry: { p: 0.1 },
  });
  const result = await execute({ spec: SPEC, version: 1, input: { body: 'x' }, provider });

  assert.ok('reason' in provider.calls[0].questions, 'asked speculatively');
  assert.equal(result.output.reason, null, 'but not used');
  assert.equal(result.nodes.reason.skipped, true);
});

test('also_above returns the secondary labels above the threshold', async () => {
  const provider = stub({
    department: { choice: 'returns', confidence: 0.6, probabilities: { returns: 0.6, billing: 0.3, other: 0.1 } },
    reason: { choice: 'other', confidence: 0.5 },
    angry: { p: 0.1 },
  });
  const result = await execute({ spec: SPEC, version: 1, input: { body: 'x' }, provider });
  assert.deepEqual(result.output.also, ['billing']);
});

test('min_confidence flags the node and human_review marks the run', async () => {
  const provider = stub({
    department: { choice: 'returns', confidence: 0.2, probabilities: { returns: 0.2, billing: 0.4, other: 0.4 } },
    reason: { choice: 'other', confidence: 0.9 },
    angry: { p: 0.1 },
  });
  const result = await execute({ spec: SPEC, version: 1, input: { body: 'x' }, provider });

  assert.equal(result.nodes.department.low_confidence, true);
  assert.equal(result.output.needs_review, true);
  assert.equal(result.needs_review, true);
});

test('low_confidence is a boolean, never absent', async () => {
  const provider = stub({
    department: { choice: 'returns', confidence: 0.99, probabilities: { returns: 0.99, billing: 0.005, other: 0.005 } },
    reason: { choice: 'other', confidence: 0.9 },
    angry: { p: 0.1 },
  });
  const result = await execute({ spec: SPEC, version: 1, input: { body: 'x' }, provider });
  assert.equal(result.output.needs_review, false);
});

test('on_low_confidence: error surfaces as a 422 problem', async () => {
  const spec = parseSpecYaml(`
pigeonhole: 1
id: strict
nodes:
  a:
    type: choice
    instructions: Pick
    criteria: { x: null, other: null }
    min_confidence: 0.9
    on_low_confidence: error
output: { r: a.choice }
`);
  const provider = stub({ a: { choice: 'x', confidence: 0.1 } });
  await assert.rejects(
    () => execute({ spec, version: 1, input: { body: 'x' }, provider }),
    (err: any) => err.code === 'low_confidence' && err.status === 422,
  );
});

test('on_low_confidence: default substitutes the named option', async () => {
  const spec = parseSpecYaml(`
pigeonhole: 1
id: defaulting
nodes:
  a:
    type: choice
    instructions: Pick
    criteria: { x: null, other: null }
    min_confidence: 0.9
    on_low_confidence: "default:other"
output: { r: a.choice }
`);
  const provider = stub({ a: { choice: 'x', confidence: 0.1 } });
  const result = await execute({ spec, version: 1, input: { body: 'x' }, provider });
  assert.equal(result.output.r, 'other');
  assert.equal(result.nodes.a.low_confidence, true);
});

test('an option the spec does not define is reported rather than passed through', async () => {
  const provider = stub({
    department: { choice: 'invented', confidence: 0.9 },
    reason: { choice: 'other', confidence: 0.9 },
    angry: { p: 0.1 },
  });
  const result = await execute({ spec: SPEC, version: 1, input: { body: 'x' }, provider });
  assert.match(result.nodes.department.error ?? '', /does not define/);
});

test('input is validated against the pipeline schema', async () => {
  const provider = stub({});
  await assert.rejects(
    () => execute({ spec: SPEC, version: 1, input: { subject: 'no body' }, provider }),
    (err: any) => err.code === 'input_invalid',
  );
});

test('an oversized input is rejected before it reaches the provider', async () => {
  const provider = stub({});
  await assert.rejects(
    () => execute({ spec: SPEC, version: 1, input: { body: 'x'.repeat(200_000) }, provider }),
    (err: any) => err.code === 'input_invalid' && /limit/.test(err.detail),
  );
  assert.equal(provider.calls.length, 0, 'no provider call should have been made');
});

test('a lazy node whose gate is false is never asked', async () => {
  const spec = parseSpecYaml(`
pigeonhole: 1
id: lazy
nodes:
  first: { type: choice, instructions: Pick, criteria: { a: null, b: null, other: null } }
  second:
    type: choice
    lazy: true
    when: first == "a"
    instructions: Deep taxonomy
    criteria: { x: null, y: null, other: null }
output: { r: second.choice }
`);
  const provider = stub({ first: { choice: 'b', confidence: 0.9 }, second: { choice: 'x', confidence: 0.9 } });
  const result = await execute({ spec, version: 1, input: { body: 'x' }, provider });

  assert.equal(provider.calls.length, 1, 'the second layer had nothing to ask');
  assert.ok(!('second' in provider.calls[0].questions));
  assert.equal(result.output.r, null);
});

test('a bare node reference in output means the answer, not the result object', async () => {
  // `output: { team: department }` and `output: { team: department.choice }`
  // must agree, exactly as `when: department == "returns"` already does.
  const spec = parseSpecYaml(`
pigeonhole: 1
id: bare-ref
nodes:
  department: { type: choice, instructions: Which team, criteria: { returns: null, billing: null, other: null } }
  angry: { type: noul, instructions: Is the customer angry }
  urgency: { type: score, instructions: How urgent, scale: { min: 0, max: 2 } }
  verdict: { type: rule, expr: 'department' }
output:
  bare: department
  explicit: department.choice
  bare_noul: angry
  bare_score: urgency
  via_rule: verdict
  probabilities: department.probabilities
`);
  const provider = stub({
    department: { choice: 'returns', confidence: 0.9, probabilities: { returns: 0.9, billing: 0.05, other: 0.05 } },
    angry: { p: 0.8 },
    urgency: { score: 2 },
  });
  const result = await execute({ spec, version: 1, input: { body: 'x' }, provider });

  assert.equal(result.output.bare, 'returns');
  assert.equal(result.output.explicit, 'returns');
  assert.equal(result.output.bare_noul, 0.8);
  assert.equal(result.output.bare_score, 2);
  assert.equal(result.output.via_rule, 'returns');
  // A genuine object output is still an object.
  assert.deepEqual(result.output.probabilities, { returns: 0.9, billing: 0.05, other: 0.05 });
});
