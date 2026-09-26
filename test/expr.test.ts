/**
 * The expression language is the one piece of the spec format that is executed
 * rather than just validated, so its sandbox is tested adversarially.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileExpr, evalCondition, evalExpr, ExprError } from '../src/spec/expr.ts';

const scope = {
  input: { body: 'hello world', count: 3 },
  department: { type: 'choice', value: 'returns', choice: 'returns', confidence: 0.93, low_confidence: false },
  angry: { type: 'noul', value: 0.85, p: 0.85, confidence: 0.7 },
  urgency: { type: 'score', value: 2, score: 2 },
  skipped_node: { type: 'choice', value: undefined, skipped: true },
};

test('literals, arithmetic and precedence', () => {
  assert.equal(evalExpr('1 + 2 * 3', {}), 7);
  assert.equal(evalExpr('(1 + 2) * 3', {}), 9);
  assert.equal(evalExpr('"a" + "b"', {}), 'ab');
  assert.equal(evalExpr('true', {}), true);
  assert.equal(evalExpr('null', {}), null);
  assert.equal(evalExpr('-4 + 1', {}), -3);
  assert.equal(evalExpr('7 % 3', {}), 1);
});

test('a bare node reference means its primary answer', () => {
  // The spec writes `when: department == "returns"` and `department.choice`
  // for the same node; both must mean the same thing.
  assert.equal(evalExpr('department == "returns"', scope), true);
  assert.equal(evalExpr('department.choice == "returns"', scope), true);
  assert.equal(evalExpr('angry > 0.7', scope), true);
  assert.equal(evalExpr('angry.p > 0.7', scope), true);
  assert.equal(evalExpr('urgency >= 2', scope), true);
});

test('the worked example from the spec', () => {
  assert.equal(evalExpr('angry.p > 0.7 ? "high" : "normal"', scope), 'high');
  assert.equal(evalExpr('angry.p > 0.9 ? "high" : "normal"', scope), 'normal');
});

test('membership, functions and null handling', () => {
  assert.equal(evalExpr('department.choice in ["returns", "billing"]', scope), true);
  assert.equal(evalExpr('department.choice in ["shipping"]', scope), false);
  assert.equal(evalExpr('len(input.body) > 5', scope), true);
  assert.equal(evalExpr('contains(input.body, "world")', scope), true);
  assert.equal(evalExpr('upper("ab")', {}), 'AB');
  assert.equal(evalExpr('round(0.8549, 2)', {}), 0.85);
  assert.equal(evalExpr('missing.thing ?? "fallback"', scope), 'fallback');
  assert.equal(evalExpr('coalesce(missing.a, missing.b, 3)', scope), 3);
});

test('a gated-out node reads as false rather than throwing', () => {
  assert.equal(evalCondition('skipped_node == "anything"', scope), false);
  assert.equal(evalExpr('skipped_node.choice', scope), undefined);
});

test('short-circuits do not evaluate the far side', () => {
  assert.equal(evalExpr('false && missing.deeply.nested', scope), false);
  assert.equal(evalExpr('true || missing.deeply.nested', scope), true);
});

test('refs are collected for graph building', () => {
  const compiled = compileExpr('angry.p > 0.7 && department.choice == "x"');
  assert.deepEqual(compiled.refs.sort(), ['angry', 'department']);
});

test('the sandbox rejects prototype access', () => {
  for (const source of ['a.__proto__', 'a.constructor', 'a["constructor"]', 'a.prototype']) {
    assert.throws(() => evalExpr(source, { a: {} }), ExprError, `should reject: ${source}`);
  }
});

test('the sandbox has no reach into the host', () => {
  // These parse as plain identifier lookups against the scope and find
  // nothing; there is no global object to reach.
  assert.equal(evalExpr('process', {}), undefined);
  assert.equal(evalExpr('globalThis', {}), undefined);
  assert.throws(() => evalExpr('require("fs")', {}), ExprError);
  assert.throws(() => evalExpr('process.exit(1)', {}), ExprError);
});

test('unknown functions and malformed input are rejected, not ignored', () => {
  assert.throws(() => evalExpr('definitelyNotAFunction(1)', {}), ExprError);
  assert.throws(() => evalExpr('1 +', {}), ExprError);
  assert.throws(() => evalExpr('"unterminated', {}), ExprError);
  assert.throws(() => evalExpr('a b c', {}), ExprError);
});
