/**
 * The executor.
 *
 * It walks the node graph in topological layers, sends each layer's model nodes
 * to the decision model as ONE call with many questions, applies edges,
 * confidence gates and rules locally, and assembles the output. Most pipelines
 * are a single layer and therefore a single call.
 */
import { randomUUID } from 'node:crypto';
import { evalCondition, evalExpr, ExprError, unwrapNodeValue } from '../spec/expr.js';
import { inputValidator, layersOf, resolveSettings, type ResolvedSettings } from '../spec/parse.js';
import { isModelNode, type PipelineSpec, type SpecNode } from '../spec/types.js';
import type { DecisionQuestion, DecisionResponse, Provider } from '../provider/types.js';
import { problem } from '../errors.js';
import { config } from '../config.js';
import type { NodeResult, RunResult } from './types.js';
import { log } from '../log.js';

export interface ExecuteOptions {
  spec: PipelineSpec;
  version: number;
  input: unknown;
  provider: Provider;
  /** Overrides spec.model.runtime; used by `pigeonhole diff --models`. */
  model?: string;
  runId?: string;
  settings?: ResolvedSettings;
}

export function newRunId(): string {
  return `run_${randomUUID().replace(/-/g, '')}`;
}

/** Validates against the pipeline's own `input` schema and the model's size limit. */
export function validateInput(spec: PipelineSpec, input: unknown): unknown {
  if (input === null || input === undefined) {
    throw problem('input_invalid', 'request is missing `input`');
  }
  const serialized = typeof input === 'string' ? input : JSON.stringify(input);
  if (serialized.length > config.maxInputChars) {
    throw problem(
      'input_invalid',
      `input is ${serialized.length} characters, over the ${config.maxInputChars} limit that keeps it inside the model's 32K context`,
      { limit_chars: config.maxInputChars },
    );
  }
  const validator = inputValidator(spec);
  if (validator && !validator(input)) {
    throw problem('input_invalid', 'input does not match the pipeline input schema', {
      errors: (validator.errors ?? []).slice(0, 10).map((e) => ({
        path: e.instancePath || '/',
        message: e.message ?? 'invalid',
      })),
    });
  }
  return input;
}

function toQuestion(node: SpecNode): DecisionQuestion | null {
  if (node.type === 'choice') {
    return { type: 'choice', instructions: node.instructions, criteria: node.criteria as Record<string, unknown> };
  }
  if (node.type === 'noul') {
    return { type: 'noul', instructions: node.instructions };
  }
  if (node.type === 'score') {
    return { type: 'score', instructions: node.instructions, scale: node.scale };
  }
  return null;
}

function minConfidenceOf(node: SpecNode): number | undefined {
  return node.type === 'rule' ? undefined : node.min_confidence;
}

function actionOf(node: SpecNode) {
  return node.type === 'rule' ? undefined : node.on_low_confidence;
}

export async function execute(opts: ExecuteOptions): Promise<RunResult> {
  const started = Date.now();
  const { spec, provider } = opts;
  const settings = opts.settings ?? resolveSettings(spec);
  const model = opts.model ?? settings.runtimeModel;
  const input = validateInput(spec, opts.input);

  const layers = layersOf(spec);
  const results: Record<string, NodeResult> = {};
  /** The expression scope: `input` plus every node answered so far. */
  const scope: Record<string, unknown> = { input };

  let decisionCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;
  let resolvedModel = model;
  let needsReview = false;

  for (const layer of layers) {
    // A lazy node is skipped outright when its gate is false; a speculative one
    // is asked regardless, and the gate only decides whether its answer is used.
    const asked: string[] = [];
    const questions: Record<string, DecisionQuestion> = {};

    for (const id of layer) {
      const node = spec.nodes[id];
      if (!isModelNode(node)) continue;
      if (node.lazy && node.when && !safeCondition(node.when, scope, id)) {
        results[id] = { type: node.type, skipped: true };
        scope[id] = { skipped: true };
        continue;
      }
      const q = toQuestion(node);
      if (q) {
        questions[id] = q;
        asked.push(id);
      }
    }

    if (asked.length > 0) {
      const response = await provider.decide({
        model,
        state: input,
        questions,
      });
      decisionCalls++;
      inputTokens += response.usage.input_tokens ?? 0;
      outputTokens += response.usage.output_tokens ?? 0;
      if (typeof response.usage.cost_usd === 'number') costUsd = (costUsd ?? 0) + response.usage.cost_usd;
      resolvedModel = response.model || resolvedModel;

      for (const id of asked) {
        const node = spec.nodes[id];
        const result = await materialize(id, node, response, opts, settings);
        if (result.low_confidence && actionOf(node) === 'human_review') needsReview = true;
        results[id] = result;
        scope[id] = result;
      }
    }

    // Gates and rules run after the layer's answers exist.
    for (const id of layer) {
      const node = spec.nodes[id];
      if (node.type === 'rule') {
        results[id] = evaluateRule(id, node.expr, node.when, scope);
        scope[id] = results[id];
        continue;
      }
      const existing = results[id];
      if (!existing || existing.skipped) continue;
      if (node.when && !safeCondition(node.when, scope, id)) {
        // Asked speculatively, gated out: the answer is kept for debugging but
        // does not reach the output.
        const gated: NodeResult = { ...existing, skipped: true };
        results[id] = gated;
        scope[id] = { ...gated, choice: undefined, value: undefined, p: undefined, score: undefined };
      }
    }
  }

  const output: Record<string, unknown> = {};
  for (const [key, mapping] of Object.entries(spec.output)) {
    if (typeof mapping === 'object' && mapping !== null && 'const' in mapping) {
      output[key] = mapping.const;
      continue;
    }
    try {
      // A bare `department` in an output mapping means the same thing it means
      // in `when: department == "returns"` — the node's answer, not the whole
      // result object. Unwrapping here is what makes the two agree.
      const value = unwrapNodeValue(evalExpr(mapping as string, scope));
      output[key] = value === undefined ? null : value;
    } catch (err) {
      if (err instanceof ExprError) throw problem('spec_invalid', `output.${key}: ${err.message}`);
      throw err;
    }
  }

  return {
    run_id: opts.runId ?? newRunId(),
    pipeline: spec.id,
    version: opts.version,
    output,
    nodes: results,
    model: resolvedModel,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
      decision_calls: decisionCalls,
    },
    latency_ms: Date.now() - started,
    cached: false,
    needs_review: needsReview,
  };
}

/** A `when` that throws should not take the request down; it gates to false. */
function safeCondition(source: string, scope: Record<string, unknown>, owner: string): boolean {
  try {
    return evalCondition(source, scope);
  } catch (err) {
    log.warn('when expression failed, treating as false', { node: owner, expr: source, error: (err as Error).message });
    return false;
  }
}

function evaluateRule(
  id: string,
  expr: string,
  when: string | undefined,
  scope: Record<string, unknown>,
): NodeResult {
  if (when && !safeCondition(when, scope, id)) return { type: 'rule', skipped: true };
  try {
    const value = unwrapNodeValue(evalExpr(expr, scope));
    return { type: 'rule', value: value === undefined ? null : value };
  } catch (err) {
    if (err instanceof ExprError) {
      log.warn('rule expression failed', { node: id, expr, error: err.message });
      return { type: 'rule', value: null, error: err.message };
    }
    throw err;
  }
}

/** Turns one provider answer into a NodeResult, applying the confidence gate. */
async function materialize(
  id: string,
  node: SpecNode,
  response: DecisionResponse,
  opts: ExecuteOptions,
  settings: ResolvedSettings,
): Promise<NodeResult> {
  const answer = response.answers[id];
  if (!answer) {
    return { type: node.type as NodeResult['type'], error: 'provider returned no answer for this node' };
  }

  const result: NodeResult = { type: node.type as NodeResult['type'] };

  if (node.type === 'choice') {
    result.choice = answer.choice;
    result.probabilities = answer.probabilities;
    result.confidence = answer.confidence;
    result.value = answer.choice;
    if (result.choice && !(result.choice in node.criteria)) {
      // A provider that invents an option is a provider bug; surface it rather
      // than letting an unknown label flow into the caller's output.
      result.error = `provider returned option "${result.choice}", which the spec does not define`;
    }
    if (node.also_above !== undefined && answer.probabilities) {
      result.also = Object.entries(answer.probabilities)
        .filter(([option, p]) => option !== result.choice && p >= node.also_above!)
        .sort((a, b) => b[1] - a[1])
        .map(([option]) => option);
    }
  } else if (node.type === 'noul') {
    result.p = answer.p;
    result.confidence = answer.confidence;
    result.value = answer.p;
  } else if (node.type === 'score') {
    result.score = answer.score;
    result.confidence = answer.confidence;
    result.value = answer.score;
  }

  const threshold = minConfidenceOf(node);
  // Always a boolean, so `x.low_confidence` in an output mapping is never null.
  result.low_confidence = threshold !== undefined && (result.confidence ?? 0) < threshold;
  if (result.low_confidence) {
    const action = actionOf(node);
    if (action === 'error') {
      throw problem('low_confidence', `node "${id}" answered below its min_confidence of ${threshold}`, {
        node: id,
        confidence: result.confidence ?? 0,
        min_confidence: threshold,
      });
    }
    if (action?.startsWith('default:')) {
      result.choice = action.slice('default:'.length);
      result.value = result.choice;
      result.action = action;
    } else if (action) {
      result.action = action;
    }
  }
  return result;
}

