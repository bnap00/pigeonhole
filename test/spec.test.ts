/** Spec parsing, the layering the executor depends on, and the linter. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inputValidator, layersOf, lint, parseSpecYaml, resolveSettings, specToYaml } from '../src/spec/parse.ts';
import { testsSchema } from '../src/compiler/prompts.ts';

const SUPPORT = readFileSync(join(import.meta.dirname, '..', 'templates', 'support-triage.yaml'), 'utf8');

test('every shipped template parses, lints and round-trips', () => {
  const dir = join(import.meta.dirname, '..', 'templates');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 5, 'the gallery should ship at least five templates');

  for (const file of files) {
    const spec = parseSpecYaml(readFileSync(join(dir, file), 'utf8'));
    assert.ok(Object.keys(spec.nodes).length > 0, `${file} has nodes`);
    assert.ok((spec.tests ?? []).length >= 10, `${file} ships at least 10 test cases`);

    // A template that trips its own linter is a bad example to ship.
    const blocking = lint(spec).filter((w) => ['no_catch_all', 'no_tests', 'split_criteria'].includes(w.code));
    assert.equal(blocking.length, 0, `${file}: ${JSON.stringify(blocking)}`);

    // Round-tripping must not change meaning.
    assert.deepEqual(parseSpecYaml(specToYaml(spec)), spec, `${file} round-trips`);
  }
});

test('speculative evaluation puts gated model nodes in the first layer', () => {
  const spec = parseSpecYaml(SUPPORT);
  const layers = layersOf(spec);

  // `return_reason` is gated on `department`, but it is still asked in layer
  // one: the gate decides whether the answer is used, not whether it is asked.
  assert.ok(layers[0].includes('return_reason'));
  assert.ok(layers[0].includes('department'));
  // Rule nodes wait for what they read.
  assert.ok(layers[1].includes('priority'));

  const modelLayers = layers.filter((l) => l.some((id) => spec.nodes[id].type !== 'rule'));
  assert.equal(modelLayers.length, 1, 'this pipeline is one Jev call');
});

test('lazy opts out of speculation and costs a second round trip', () => {
  const spec = parseSpecYaml(`
pigeonhole: 1
id: lazy-demo
nodes:
  first: { type: choice, instructions: Pick one, criteria: { a: null, b: null, other: null } }
  second:
    type: choice
    lazy: true
    when: first == "a"
    instructions: Only when a
    criteria: { x: null, y: null, other: null }
output: { r: second.choice }
`);
  const layers = layersOf(spec);
  assert.deepEqual(layers[0], ['first']);
  assert.deepEqual(layers[1], ['second']);
});

test('dependency cycles are rejected at parse time', () => {
  assert.throws(
    () =>
      parseSpecYaml(`
pigeonhole: 1
id: cyclic
nodes:
  a: { type: rule, expr: 'b.value' }
  b: { type: rule, expr: 'a.value' }
output: { r: a.value }
`),
    /cycle/,
  );
});

test('a fallback option that does not exist is rejected', () => {
  assert.throws(
    () =>
      parseSpecYaml(`
pigeonhole: 1
id: bad-default
nodes:
  a:
    type: choice
    instructions: Pick
    criteria: { p: null, q: null }
    on_low_confidence: "default:nope"
output: { r: a.choice }
`),
    /does not define/,
  );
});

test('expressions referencing unknown nodes are rejected', () => {
  assert.throws(
    () =>
      parseSpecYaml(`
pigeonhole: 1
id: bad-ref
nodes:
  a: { type: noul, instructions: Is it so? }
output: { r: ghost.value }
`),
    /not a node id/,
  );
});

test('the linter flags a choice node with no catch-all', () => {
  const spec = parseSpecYaml(`
pigeonhole: 1
id: no-catchall
nodes:
  a: { type: choice, instructions: Pick one of these, criteria: { red: null, blue: null } }
output: { r: a.choice }
`);
  assert.ok(lint(spec).some((w) => w.code === 'no_catch_all'));
});

test('compose settings resolve to safe defaults', () => {
  const { compose: _demoOverrides, ...spec } = parseSpecYaml(SUPPORT);
  const settings = resolveSettings(spec);
  assert.equal(settings.cache, false, 'caching is off unless asked for');
  assert.equal(settings.retain, 'low_confidence');
  assert.equal(settings.runtimeModel, 'jev-latest');
});

test('only keys with a stable answer are labelable', async () => {
  const { labelableOutputKeys } = await import('../src/spec/parse.ts');
  const spec = parseSpecYaml(`
pigeonhole: 1
id: labelable
nodes:
  dept: { type: choice, instructions: Which team, criteria: { a: null, b: null, other: null }, min_confidence: 0.4 }
  angry: { type: noul, instructions: Is the customer angry }
  urgency: { type: score, instructions: How urgent, scale: { min: 0, max: 2 } }
  pri: { type: rule, expr: 'angry.p > 0.7 ? "high" : "low"' }
output:
  team: dept.choice
  team_conf: dept.confidence
  probs: dept.probabilities
  review: dept.low_confidence
  angry: angry.p
  urgency: urgency.score
  priority: pri.value
`);
  const keys = labelableOutputKeys(spec);

  // A confidence and a probability map cannot carry a stable expectation.
  assert.ok(!('team_conf' in keys), 'confidence is not labelable');
  assert.ok(!('probs' in keys), 'a probability map is not labelable');

  assert.deepEqual(keys.team, { type: 'enum', values: ['a', 'b', 'other'] });
  assert.deepEqual(keys.review, { type: 'boolean', values: ['true', 'false'] });
  assert.deepEqual(keys.angry, { type: 'boolean', values: ['true', 'false'] });
  assert.deepEqual(keys.urgency, { type: 'enum', values: ['0', '1', '2'] });
  assert.deepEqual(keys.priority, { type: 'any' });
});

test('a yes/no expectation reads a probability by threshold', async () => {
  const { matchesExpectation } = await import('../src/spec/parse.ts');
  assert.equal(matchesExpectation('true', 0.85), true);
  assert.equal(matchesExpectation('true', 0.2), false);
  assert.equal(matchesExpectation('false', 0.2), true);
  assert.equal(matchesExpectation('false', 0.5), false, '0.5 counts as true');

  assert.equal(matchesExpectation('returns', 'returns'), true);
  assert.equal(matchesExpectation('returns', 'billing'), false);
  assert.equal(matchesExpectation('2', 2), true);
  assert.equal(matchesExpectation('true', true), true);
  assert.equal(matchesExpectation('high', null), false);
  assert.equal(matchesExpectation('', null), true, 'an unset expectation matches no answer');
});

test('a passing yes/no case is not recorded as a confusion', async () => {
  const { runEval } = await import('../src/evals/run.ts');
  const spec = parseSpecYaml(`
pigeonhole: 1
id: noul-eval
nodes:
  angry: { type: noul, instructions: Is the customer angry }
output: { angry: angry.p }
`);
  const provider = {
    async decide() {
      return { answers: { angry: { p: 0.9, confidence: 0.8 } }, model: 'stub', usage: { input_tokens: 1 } };
    },
    async chat() { throw new Error('unused'); },
  };
  const report = await runEval({
    spec,
    version: 1,
    cases: [{ input: { body: 'x' }, expect: { angry: 'true' } }],
    provider: provider as never,
  });
  assert.equal(report.passed, 1, 'p=0.9 satisfies `angry: true`');
  // The matrix must put it on the diagonal, not report `true -> 0.9`.
  assert.deepEqual(report.confusion.angry, { true: { true: 1 } });
});

/**
 * A test case whose input fails the pipeline's own input schema is rejected by
 * `execute()` before any model is called, so it can never pass. A suite built
 * entirely from those evaluates at 0% while looking like a model problem, which
 * is exactly the failure this guards.
 */
test('every template test case satisfies its own input schema', () => {
  const dir = join(import.meta.dirname, '..', 'templates');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const spec = parseSpecYaml(readFileSync(join(dir, file), 'utf8'));
    const validator = inputValidator(spec);
    if (!validator) continue;
    for (const [i, testCase] of (spec.tests ?? []).entries()) {
      assert.ok(
        validator(testCase.input),
        `${file} test ${testCase.name ?? i}: ${JSON.stringify(validator.errors)}`,
      );
    }
  }
});

test('the generated-test schema requires every input field', () => {
  const schema = testsSchema(['post_title', 'post_text'], {
    category: { type: 'enum', values: ['lead', 'noise'] },
  }) as any;
  const item = schema.properties.tests.items;

  // Without this the model omits fields the pipeline marks required, and every
  // generated case is rejected before it reaches a model.
  assert.deepEqual(item.properties.input.required, ['post_title', 'post_text']);
  assert.deepEqual(item.properties.expect.required, ['category']);
});

test('the linter flags option text that a YAML comma split into empty keys', () => {
  const spec = parseSpecYaml(`
pigeonhole: 1
id: split
nodes:
  reason:
    type: choice
    instructions: Why is it being returned?
    criteria:
      damaged: { what: Arrived broken, scuffed or torn. }
      other: { what: "Anything else, including questions." }
output: { reason: reason.choice }
`);
  const found = lint(spec).filter((w) => w.code === 'split_criteria');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /"damaged"/);
});
