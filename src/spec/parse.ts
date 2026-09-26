/**
 * YAML in, validated spec out, plus the graph analysis the executor needs.
 *
 * Parsing, schema validation, semantic checks and linting all happen here so a
 * bad spec cannot reach the executor and a merely questionable one produces a
 * warning the UI can show next to the node it concerns.
 */
import YAML from 'yaml';
import { isDecisionModel, notADecisionModel } from '../provider/models.js';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { SPEC_SCHEMA } from './schema.js';
import { compileExpr, ExprError } from './expr.js';
import { isModelNode, type LintWarning, type PipelineSpec, type SpecNode } from './types.js';
import { problem } from '../errors.js';

// ajv-formats ships a CJS `export =` function; NodeNext types it as a namespace.
const addFormats = addFormatsModule as unknown as (ajv: unknown) => void;

// Draft 2020-12, so a pipeline's own `input` schema can use current JSON Schema.
const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);
const validateSpec: ValidateFunction = ajv.compile(SPEC_SCHEMA as unknown as object);

/** Ajv for a pipeline's own `input` schema, compiled once per spec and cached. */
const inputValidators = new Map<string, ValidateFunction>();

export function inputValidator(spec: PipelineSpec): ValidateFunction | null {
  if (!spec.input) return null;
  const key = `${spec.id}@${spec.version ?? 0}`;
  const hit = inputValidators.get(key);
  if (hit) return hit;
  const compiled = ajv.compile({ type: 'object', ...spec.input } as object);
  if (inputValidators.size > 500) inputValidators.clear();
  inputValidators.set(key, compiled);
  return compiled;
}

export function parseSpecYaml(text: string): PipelineSpec {
  let raw: unknown;
  try {
    raw = YAML.parse(text, { prettyErrors: true });
  } catch (err) {
    throw problem('spec_invalid', `spec is not valid YAML: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') throw problem('spec_invalid', 'spec must be a YAML mapping');
  return validate(raw as Record<string, unknown>);
}

export function specToYaml(spec: PipelineSpec): string {
  return YAML.stringify(spec, { lineWidth: 100 });
}

/** Schema check, then the semantic rules a JSON Schema cannot express. */
export function validate(raw: Record<string, unknown>): PipelineSpec {
  // Checked before the schema so the refusal says why rather than "must match
  // pattern". `fallback_model` re-asks a low-confidence node through a chat
  // model, and classifications here come only from decision models.
  const rawNodes = (raw.nodes ?? {}) as Record<string, { on_low_confidence?: unknown }>;
  for (const [id, node] of Object.entries(rawNodes)) {
    if (node?.on_low_confidence === 'fallback_model') {
      throw problem(
        'spec_invalid',
        `node "${id}" uses on_low_confidence: fallback_model, which re-asks a chat model. ` +
          'Classifications here are answered only by decision models. ' +
          'Use human_review, error or default:<option>.',
        { node: id },
      );
    }
  }
  const runtime = (raw.model as { runtime?: unknown } | undefined)?.runtime;
  if (typeof runtime === 'string' && !isDecisionModel(runtime)) {
    throw problem('spec_invalid', `model.runtime: ${notADecisionModel(runtime)}`);
  }
  if (!validateSpec(raw)) {
    const errors = (validateSpec.errors ?? []).slice(0, 12).map((e) => ({
      path: e.instancePath || '/',
      message: e.message ?? 'invalid',
      ...(e.params && Object.keys(e.params).length ? { params: e.params } : {}),
    }));
    throw problem('spec_invalid', `spec failed schema validation (${errors.length} problem(s))`, { errors });
  }
  const spec = raw as unknown as PipelineSpec;
  const nodeIds = new Set(Object.keys(spec.nodes));

  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.when) assertExpr(node.when, nodeIds, id, 'when');
    if (node.type === 'rule') assertExpr(node.expr, nodeIds, id, 'expr');
    if (node.type === 'choice') {
      const options = Object.keys(node.criteria);
      if (options.length > 255) {
        throw problem('spec_invalid', `node "${id}" has ${options.length} options; the Decisions API allows at most 255`);
      }
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
        throw problem('spec_invalid', `node "${id}" has options that differ only by case`);
      }
      const fallback = lowConfidenceDefault(node.on_low_confidence);
      if (fallback && !options.includes(fallback)) {
        throw problem('spec_invalid', `node "${id}" falls back to option "${fallback}", which it does not define`);
      }
    }
    if (node.type === 'score' && node.scale.max <= node.scale.min) {
      throw problem('spec_invalid', `node "${id}" has a scale whose max is not above its min`);
    }
  }

  for (const [key, mapping] of Object.entries(spec.output)) {
    if (typeof mapping === 'string') assertExpr(mapping, nodeIds, `output.${key}`, 'output');
  }

  // A cycle would make layering impossible, so reject it before the executor sees it.
  layersOf(spec);
  return spec;
}

function lowConfidenceDefault(action: string | undefined): string | null {
  return action && action.startsWith('default:') ? action.slice('default:'.length) : null;
}

/** Scope keys an expression may reference: node ids plus `input`. */
function assertExpr(source: string, nodeIds: Set<string>, owner: string, kind: string): void {
  let refs: string[];
  try {
    refs = compileExpr(source).refs;
  } catch (err) {
    if (err instanceof ExprError) throw problem('spec_invalid', `${owner}: ${err.message}`);
    throw err;
  }
  for (const ref of refs) {
    if (ref === 'input' || nodeIds.has(ref)) continue;
    throw problem(
      'spec_invalid',
      `${owner} ${kind} references "${ref}", which is not a node id or \`input\``,
    );
  }
}

/** Dependencies a node has on other nodes, via `when` or `expr`. */
export function dependenciesOf(id: string, node: SpecNode, nodeIds: Set<string>): string[] {
  const deps = new Set<string>();
  const add = (source: string) => {
    for (const ref of compileExpr(source).refs) {
      if (ref !== id && nodeIds.has(ref)) deps.add(ref);
    }
  };
  if (node.when) add(node.when);
  if (node.type === 'rule') add(node.expr);
  return [...deps];
}

/**
 * Topological layers.
 *
 * A model node whose only dependency is a `when` gate still goes in layer one:
 * speculative evaluation means the gate decides whether the answer is *used*,
 * not whether it is asked. The model evaluates questions in parallel, so one extra
 * question costs tokens and almost no latency. `lazy: true` opts out, which is
 * what pushes a node into a later layer and costs a second round trip.
 */
export function layersOf(spec: PipelineSpec): string[][] {
  const nodeIds = new Set(Object.keys(spec.nodes));
  const blocking = new Map<string, Set<string>>();

  for (const [id, node] of Object.entries(spec.nodes)) {
    const deps = dependenciesOf(id, node, nodeIds);
    const speculative = isModelNode(node) && !node.lazy;
    // Rule nodes always wait for what they read; model nodes only when lazy.
    blocking.set(id, new Set(speculative ? [] : deps));
  }

  const layers: string[][] = [];
  const done = new Set<string>();
  let remaining = [...nodeIds];

  while (remaining.length > 0) {
    const ready = remaining.filter((id) => [...blocking.get(id)!].every((d) => done.has(d)));
    if (ready.length === 0) {
      throw problem('spec_invalid', `spec has a dependency cycle among nodes: ${remaining.join(', ')}`);
    }
    layers.push(ready.sort());
    ready.forEach((id) => done.add(id));
    remaining = remaining.filter((id) => !done.has(id));
  }
  return layers;
}

/** Advisory checks. Never block a save; shown in the UI and by `pigeonhole test`. */
export function lint(spec: PipelineSpec): LintWarning[] {
  const warnings: LintWarning[] = [];
  const nodeIds = new Set(Object.keys(spec.nodes));

  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.type === 'choice') {
      const options = Object.keys(node.criteria);
      const hasCatchAll = options.some((o) => /^(other|none|unknown|unclear|n_a|na)$/i.test(o));
      if (!hasCatchAll) {
        warnings.push({
          node: id,
          code: 'no_catch_all',
          message: `choice node "${id}" has no catch-all option. Add "other" so inputs that fit nothing are not forced into a wrong bucket.`,
        });
      }
      const thin = options.filter((o) => {
        const c = node.criteria[o];
        if (c === null || c === undefined) return true;
        if (typeof c === 'string') return c.trim().length < 12;
        if (typeof c === 'object' && !Array.isArray(c)) return !('what' in c) || String(c.what ?? '').length < 12;
        return false;
      });
      if (thin.length > 0 && options.length > 2) {
        warnings.push({
          node: id,
          code: 'thin_criteria',
          message: `options ${thin.map((t) => `"${t}"`).join(', ')} on "${id}" have little or no definition. Neighbouring options separate better with \`what\` and \`not_for\`.`,
        });
      }
      if (node.min_confidence !== undefined && node.on_low_confidence === undefined) {
        warnings.push({
          node: id,
          code: 'no_low_confidence_action',
          message: `"${id}" sets min_confidence but no on_low_confidence, so a low-confidence answer is only flagged, never routed.`,
        });
      }
      if (options.length > 60 && !node.lazy) {
        warnings.push({
          node: id,
          code: 'large_option_set',
          message: `"${id}" has ${options.length} options and is asked speculatively on every request. Consider \`lazy: true\` or a two-level hierarchy.`,
        });
      }
    }
    if (isModelNode(node) && node.instructions.trim().length < 10) {
      warnings.push({ node: id, code: 'thin_instructions', message: `"${id}" has very short instructions.` });
    }
  }

  const referenced = new Set<string>();
  for (const mapping of Object.values(spec.output)) {
    if (typeof mapping === 'string') compileExpr(mapping).refs.forEach((r) => referenced.add(r));
  }
  for (const node of Object.values(spec.nodes)) {
    if (node.when) compileExpr(node.when).refs.forEach((r) => referenced.add(r));
    if (node.type === 'rule') compileExpr(node.expr).refs.forEach((r) => referenced.add(r));
  }
  for (const id of nodeIds) {
    if (!referenced.has(id)) {
      warnings.push({
        node: id,
        code: 'unused_node',
        message: `"${id}" is never read by another node or by output, so it costs tokens and changes nothing.`,
      });
    }
  }

  if (!spec.tests || spec.tests.length === 0) {
    warnings.push({
      code: 'no_tests',
      message: 'This pipeline has no test cases, so drift when `jev-latest` moves will go unnoticed.',
    });
  } else if (spec.tests.length < 10) {
    warnings.push({
      code: 'few_tests',
      message: `Only ${spec.tests.length} test cases. 10 to 30 covering every option makes eval accuracy meaningful.`,
    });
  }

  if (!spec.input) {
    warnings.push({ code: 'no_input_schema', message: 'No `input` schema, so callers get no validation and the generated OpenAPI is untyped.' });
  }
  return warnings;
}

/** Defaults resolved once so the executor never has to branch on undefined. */
export function resolveSettings(spec: PipelineSpec) {
  const c = spec.compose ?? {};
  return {
    cache: c.cache?.mode === 'memory',
    cacheTtl: c.cache?.ttl ?? 300,
    telemetry: c.logging?.telemetry !== 'none',
    retain: c.logging?.retain ?? 'low_confidence',
    sampleRate: c.logging?.sample_rate ?? 0.01,
    retentionDays: c.logging?.retention_days ?? 90,
    inputLogging: c.logging?.input ?? 'full',
    redactPii: c.logging?.redact_pii ?? false,
    runtimeModel: spec.model?.runtime ?? 'jev-latest',
    compilerModel: spec.model?.compiler ?? 'anthropic/claude-sonnet-5',
  };
}
export type ResolvedSettings = ReturnType<typeof resolveSettings>;

/**
 * Which output keys can carry a stable labelled expectation.
 *
 * A test case says "this input should produce that output". That is only
 * meaningful for a discrete answer: a chosen option, a point on a scale, a
 * rule's result, a low-confidence flag, or a yes/no read of a probability.
 * It is NOT meaningful for a raw probability or a confidence score — nobody
 * can say in advance that an input deserves 0.83 rather than 0.86, and a test
 * that asserts it fails forever.
 *
 * Used by the compiler to constrain test generation, and by the UI to decide
 * which columns are worth showing in the test table.
 */
export function labelableOutputKeys(spec: PipelineSpec): Record<string, { type: 'enum' | 'number' | 'boolean' | 'any'; values?: string[] }> {
  const out: Record<string, { type: 'enum' | 'number' | 'boolean' | 'any'; values?: string[] }> = {};

  for (const [key, mapping] of Object.entries(spec.output)) {
    if (typeof mapping !== 'string') continue;

    // Only simple `node` or `node.field` mappings are predictable; a mapping
    // with an expression in it is a rule by another name and stays `any`.
    const simple = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/.exec(mapping.trim());
    if (!simple) continue;

    const [, nodeId, field] = simple;
    const node = spec.nodes[nodeId];
    if (!node) continue;

    if (field === 'confidence' || field === 'probabilities' || field === 'also') continue;
    if (field === 'low_confidence') {
      out[key] = { type: 'boolean', values: ['true', 'false'] };
      continue;
    }

    switch (node.type) {
      case 'choice':
        if (field === undefined || field === 'choice' || field === 'value') {
          out[key] = { type: 'enum', values: Object.keys(node.criteria) };
        }
        break;
      case 'score':
        if (field === undefined || field === 'score' || field === 'value') {
          const { min, max } = node.scale;
          const steps = Number.isInteger(min) && Number.isInteger(max) && max - min <= 20
            ? Array.from({ length: max - min + 1 }, (_, i) => String(min + i))
            : undefined;
          out[key] = steps ? { type: 'enum', values: steps } : { type: 'number' };
        }
        break;
      case 'noul':
        // A probability is not labelable, but "is it true of this input" is.
        if (field === undefined || field === 'p' || field === 'value') {
          out[key] = { type: 'boolean', values: ['true', 'false'] };
        }
        break;
      case 'rule':
        if (field === undefined || field === 'value') out[key] = { type: 'any' };
        break;
    }
  }
  return out;
}

/**
 * Compares one expected value against what a run actually produced.
 *
 * The only coercion is for yes/no expectations against a probability: a test
 * that says `angry: true` passes when the model returned p >= 0.5. Everything
 * else is a string comparison, so a test cannot pass by accident.
 */
export function matchesExpectation(expected: unknown, actual: unknown): boolean {
  if (actual === undefined || actual === null) {
    return expected === null || expected === undefined || expected === '';
  }
  const want = String(expected).trim();

  if (typeof actual === 'number' && (want === 'true' || want === 'false')) {
    return (actual >= 0.5) === (want === 'true');
  }
  if (typeof actual === 'boolean') {
    return String(actual) === want.toLowerCase();
  }
  if (typeof actual === 'number') {
    const wanted = Number(want);
    return Number.isFinite(wanted) ? Math.abs(actual - wanted) < 1e-9 : false;
  }
  return String(actual) === want;
}
