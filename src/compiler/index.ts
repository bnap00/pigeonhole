/**
 * The compiler: a description in, a reviewed spec out.
 *
 * Five passes — draft, sharpen, tests, dry run, repair — each a separate model
 * call with structured output. The whole thing is 4 to 6 model calls plus a dry
 * run over 30 inputs, which is far too long for a request, so it runs as a
 * queue job.
 *
 * Durability without Workflows: every pass writes its output to `compile_runs`
 * before the next begins, and `runCompile` skips any pass already recorded. A
 * worker that dies mid-compile is retried by the queue and resumes at the first
 * incomplete pass rather than paying again for the finished ones. On a $2
 * compile that is the difference between a retry and a loss.
 */
import { randomUUID } from 'node:crypto';
import { provider } from '../provider/index.js';
import {
  DRAFT_SCHEMA, DRAFT_SYSTEM, INCREMENTAL_SCHEMA, INCREMENTAL_SYSTEM, REPAIR_SYSTEM,
  SHARPEN_SYSTEM, TESTS_SYSTEM, draftUser, incrementalUser, repairUser, sharpenSchema,
  sharpenUser, testsSchema,
} from './prompts.js';
import {
  inputValidator, labelableOutputKeys, matchesExpectation, parseSpecYaml, resolveSettings,
  specToYaml, validate,
} from '../spec/parse.js';
import { compileExpr } from '../spec/expr.js';
import type { ChoiceNode, PipelineSpec, SpecNode, TestCase } from '../spec/types.js';
import { diffSpecs } from './diff.js';
import { execute } from '../executor/execute.js';
import * as repo from '../db/repo.js';
import { publishBus } from '../cache/bus.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { problem } from '../errors.js';

export const COMPILE_PASSES = ['draft', 'sharpen', 'tests', 'dry_run', 'repair'] as const;
export type CompilePass = (typeof COMPILE_PASSES)[number];

export interface CompileInput {
  compileId: string;
  pipelineId: string;
  description: string;
  samples?: string[];
  mode?: 'full' | 'incremental';
  instruction?: string;
  compilerModel?: string;
  runtimeModel?: string;
  /** Skips the dry run, for stacks with no provider key configured. */
  skipDryRun?: boolean;
}

export const newCompileId = () => `cmp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/**
 * A rough cost estimate shown before the compile runs, and reserved against
 * the monthly budget. OpenRouter's reported cost trues it up afterwards, so the
 * estimate calibrates against reality over time.
 */
export function estimateCost(description: string, mode: 'full' | 'incremental'): number {
  const descriptionTokens = Math.ceil(description.length / 4);
  // draft + sharpen (per node, assume 3) + tests + up to 2 repairs
  const calls = mode === 'incremental' ? 2 : 7;
  const inputTokens = calls * (descriptionTokens + 900);
  const outputTokens = calls * 1200;
  // Sonnet-class list prices, which is what the default compiler model is.
  return (inputTokens / 1e6) * 3 + (outputTokens / 1e6) * 15;
}

async function emit(compileId: string, pipelineId: string, payload: Record<string, unknown>): Promise<void> {
  await repo.setCompileProgress(compileId, payload);
  await publishBus({ type: 'compile_progress', compile_id: compileId, pipeline: pipelineId, payload });
}

/** Reads a completed pass from the database, which is what makes resume work. */
function completed<T>(row: repo.CompileRunRow | null, pass: CompilePass): T | null {
  const value = row?.passes?.[pass];
  return (value as T) ?? null;
}

export async function runCompile(input: CompileInput): Promise<{ spec: PipelineSpec; diff: unknown }> {
  const { compileId, pipelineId } = input;
  const pipeline = await repo.requirePipeline(pipelineId);
  const current = (pipeline.draft_spec as PipelineSpec | null) ?? (await repo.latestVersion(pipelineId))?.spec ?? null;
  const chat = provider();
  const model = input.compilerModel ?? current?.model?.compiler ?? config.defaultCompilerModel;

  await repo.setCompileStatus(compileId, 'running');
  let costSoFar = 0;

  const track = (usage: { input_tokens: number; output_tokens: number; cost_usd?: number }) => {
    costSoFar += usage.cost_usd ?? 0;
  };

  // ------------------------------------------------ incremental: one pass
  if (input.mode === 'incremental') {
    if (!current) throw problem('conflict', 'an incremental edit needs an existing spec to edit');
    await emit(compileId, pipelineId, { pass: 'draft', index: 1, of: 2, message: 'applying the edit' });
    const row = await repo.getCompileRun(compileId);
    let spec = completed<PipelineSpec>(row, 'draft');
    if (!spec) {
      const res = await chat.chat({
        model,
        system: INCREMENTAL_SYSTEM,
        messages: [{ role: 'user', content: incrementalUser(specToYaml(current), input.instruction ?? '') }],
        schema: { name: 'incremental_edit', schema: INCREMENTAL_SCHEMA as unknown as Record<string, unknown> },
      });
      track(res.usage);
      const parsed = res.json as { spec_yaml: string } | undefined;
      if (!parsed?.spec_yaml) throw problem('provider_error', 'the compiler returned no spec');
      spec = parseSpecYaml(parsed.spec_yaml);
      spec.id = pipelineId;
      await repo.savePass(compileId, 'draft', spec);
    }
    const tested = await maybeDryRun(spec, input, compileId, pipelineId, 2, 2);
    const diff = diffSpecs(current, tested);
    await repo.setCompileStatus(compileId, 'done', { diff, result_spec: tested, actual_cost: costSoFar });
    await emit(compileId, pipelineId, { pass: 'done', index: 2, of: 2, message: diff.summary });
    return { spec: tested, diff };
  }

  // -------------------------------------------------------- pass 1: draft
  let row = await repo.getCompileRun(compileId);
  let draft = completed<PipelineSpec>(row, 'draft');
  if (!draft) {
    await emit(compileId, pipelineId, { pass: 'draft', index: 1, of: 5, message: 'drafting the decisions' });
    draft = await draftPass(input, model, chat, track);
    await repo.savePass(compileId, 'draft', draft);
  } else {
    log.info('resuming compile, draft already done', { compile_id: compileId });
  }

  // ------------------------------------------------------ pass 2: sharpen
  row = await repo.getCompileRun(compileId);
  let sharpened = completed<PipelineSpec>(row, 'sharpen');
  if (!sharpened) {
    sharpened = await sharpenPass(draft, input, model, chat, track, compileId, pipelineId);
    await repo.savePass(compileId, 'sharpen', sharpened);
  }

  // -------------------------------------------------------- pass 3: tests
  row = await repo.getCompileRun(compileId);
  let withTests = completed<PipelineSpec>(row, 'tests');
  if (!withTests) {
    await emit(compileId, pipelineId, { pass: 'tests', index: 3, of: 5, message: 'generating test cases' });
    withTests = await testsPass(sharpened, model, chat, track);
    await repo.savePass(compileId, 'tests', withTests);
  }

  // ------------------------------------------- passes 4 and 5: dry run, repair
  const final = await maybeDryRun(withTests, input, compileId, pipelineId, 4, 5);

  const diff = diffSpecs(current, final);
  await repo.setCompileStatus(compileId, 'done', { diff, result_spec: final, actual_cost: costSoFar });
  await emit(compileId, pipelineId, { pass: 'done', index: 5, of: 5, message: diff.summary });
  log.info('compile finished', { compile_id: compileId, pipeline: pipelineId, cost_usd: costSoFar });
  return { spec: final, diff };
}

// --------------------------------------------------------------- the passes

type Track = (usage: { input_tokens: number; output_tokens: number; cost_usd?: number }) => void;

async function draftPass(
  input: CompileInput,
  model: string,
  chat: ReturnType<typeof provider>,
  track: Track,
): Promise<PipelineSpec> {
  const res = await chat.chat({
    model,
    system: DRAFT_SYSTEM,
    messages: [{ role: 'user', content: draftUser(input.description, input.samples ?? []) }],
    schema: { name: 'pipeline_draft', schema: DRAFT_SCHEMA as unknown as Record<string, unknown> },
  });
  track(res.usage);
  const draft = res.json as any;
  if (!draft?.nodes) throw problem('provider_error', 'the compiler returned no nodes');

  const nodes: Record<string, SpecNode> = {};
  for (const n of draft.nodes) {
    const id = String(n.id).replace(/[^a-zA-Z0-9_]/g, '_');
    if (n.type === 'rule') {
      nodes[id] = { type: 'rule', expr: n.expr ?? '"unknown"', ...(n.when ? { when: n.when } : {}) };
    } else if (n.type === 'choice') {
      const options: string[] = (n.options ?? []).map(String);
      if (options.length < 2) continue;
      const node: ChoiceNode = {
        type: 'choice',
        instructions: n.instructions ?? n.purpose,
        criteria: Object.fromEntries(options.map((o) => [o, null])),
        ...(n.when ? { when: n.when } : {}),
        ...(typeof n.min_confidence === 'number' ? { min_confidence: n.min_confidence } : {}),
        ...(n.on_low_confidence ? { on_low_confidence: n.on_low_confidence } : {}),
      };
      nodes[id] = node;
    } else if (n.type === 'score') {
      const min = n.scale_min ?? 0;
      const max = n.scale_max ?? 2;
      const labels: string[] = n.scale_labels ?? [];
      nodes[id] = {
        type: 'score',
        instructions: n.instructions ?? n.purpose,
        scale: {
          min,
          max,
          ...(labels.length > 0
            ? { labels: Object.fromEntries(labels.map((l, i) => [String(min + i), l])) }
            : {}),
        },
        ...(n.when ? { when: n.when } : {}),
      };
    } else {
      nodes[id] = { type: 'noul', instructions: n.instructions ?? n.purpose, ...(n.when ? { when: n.when } : {}) };
    }
  }

  sanitizeNodes(nodes);

  if (Object.keys(nodes).length === 0) {
    throw problem(
      'provider_error',
      'the compiler produced no usable nodes. Every choice node needs at least two options. ' +
        'Try a more specific description, or a stronger compiler model.',
    );
  }

  const properties: Record<string, unknown> = {};
  for (const field of draft.input?.properties ?? []) {
    properties[field.name] = { type: field.type, description: field.description };
  }
  // A model that lists a required field it never defined would make every
  // input fail validation, so required is narrowed to what actually exists.
  const required: string[] = (draft.input?.required ?? []).filter((name: string) => name in properties);
  if (required.length === 0 && Object.keys(properties).length > 0) {
    required.push(Object.keys(properties)[0]);
  }

  const spec: PipelineSpec = {
    pigeonhole: 1,
    id: input.pipelineId,
    description: input.description,
    input: {
      type: 'object',
      properties,
      required,
    },
    model: {
      runtime: input.runtimeModel ?? config.defaultRuntimeModel,
      compiler: model,
    },
    nodes,
    output: Object.fromEntries(
      (draft.output ?? [])
        .filter((o: any) => o?.key && o?.expr)
        .map((o: any) => [String(o.key).replace(/[^a-zA-Z0-9_]/g, '_'), o.expr]),
    ),
  };
  if (Object.keys(spec.output).length === 0) {
    // Without an output mapping the endpoint would return an empty object, so
    // fall back to exposing every node's answer rather than shipping nothing.
    spec.output = Object.fromEntries(
      Object.entries(nodes).map(([id, node]) => [
        id,
        node.type === 'choice' ? `${id}.choice` : node.type === 'noul' ? `${id}.p` : `${id}.value`,
      ]),
    );
  }
  return validate(spec as unknown as Record<string, unknown>);
}

/**
 * Drops anything the model got wrong that would otherwise fail validation and
 * throw away a paid draft.
 *
 * A model will occasionally invent a `when` that does not parse, name an
 * on_low_confidence action that does not exist, or reference a node it did not
 * create. None of that is worth failing a compile over: the sane response is
 * to drop the bad field, keep the good draft, and let the linter and the dry
 * run surface what is missing.
 */
function sanitizeNodes(nodes: Record<string, SpecNode>): void {
  const ids = new Set(Object.keys(nodes));
  const validExpr = (source: string | undefined): boolean => {
    if (!source || typeof source !== 'string' || !source.trim()) return false;
    try {
      return compileExpr(source).refs.every((ref) => ref === 'input' || ids.has(ref));
    } catch {
      return false;
    }
  };

  for (const [id, node] of Object.entries(nodes)) {
    if (node.when && !validExpr(node.when)) {
      log.warn('compiler produced an unusable `when`; dropping it', { node: id, when: node.when });
      delete node.when;
    }

    if (node.type === 'rule' && !validExpr(node.expr)) {
      log.warn('compiler produced an unusable rule expression; dropping the node', { node: id, expr: node.expr });
      delete nodes[id];
      ids.delete(id);
      continue;
    }

    if (node.type !== 'rule') {
      if (typeof node.min_confidence === 'number') {
        node.min_confidence = Math.min(1, Math.max(0, node.min_confidence));
      } else {
        delete node.min_confidence;
      }

      // A model may still propose `fallback_model`, which would re-ask a chat
      // model. Its intent — do not trust this answer — is kept by sending the
      // node to human review instead.
      if ((node.on_low_confidence as string | undefined) === 'fallback_model') {
        node.on_low_confidence = 'human_review';
      }
      const action = node.on_low_confidence;
      const options = node.type === 'choice' ? Object.keys(node.criteria) : [];
      const valid =
        action === undefined ||
        action === 'human_review' ||
        action === 'error' ||
        (action.startsWith('default:') && options.includes(action.slice('default:'.length)));
      if (!valid) {
        log.warn('compiler produced an unknown on_low_confidence action; dropping it', { node: id, action });
        delete node.on_low_confidence;
      }
    }
  }
}

/** Pass 2, one model call per choice node, run concurrently. */
async function sharpenPass(
  draft: PipelineSpec,
  input: CompileInput,
  model: string,
  chat: ReturnType<typeof provider>,
  track: Track,
  compileId: string,
  pipelineId: string,
): Promise<PipelineSpec> {
  const choiceNodes = Object.entries(draft.nodes).filter(([, n]) => n.type === 'choice') as [string, ChoiceNode][];
  const spec: PipelineSpec = structuredClone(draft);
  let done = 0;

  await Promise.all(
    choiceNodes.map(async ([id, node]) => {
      const options = Object.keys(node.criteria);
      try {
        const res = await chat.chat({
          model,
          system: SHARPEN_SYSTEM,
          messages: [
            { role: 'user', content: sharpenUser(id, node.instructions, options, input.description) },
          ],
          schema: {
            name: 'sharpened_options',
            schema: sharpenSchema(options) as unknown as Record<string, unknown>,
          },
        });
        track(res.usage);
        const parsed = res.json as { options?: { name: string; what: string; not_for?: string; examples?: string[] }[] };
        const target = spec.nodes[id] as ChoiceNode;
        for (const option of parsed?.options ?? []) {
          if (!(option.name in target.criteria)) continue;
          target.criteria[option.name] = {
            what: option.what,
            ...(option.not_for ? { not_for: option.not_for } : {}),
            ...(option.examples?.length ? { examples: option.examples.slice(0, 3) } : {}),
          };
        }
      } catch (err) {
        // A node that fails to sharpen keeps its bare option names rather than
        // failing the whole compile. The linter will flag it.
        log.warn('sharpen failed for a node', { node: id, error: (err as Error).message });
      } finally {
        done++;
        await emit(compileId, pipelineId, {
          pass: 'sharpen',
          index: 2,
          of: 5,
          message: `sharpening criteria (${done}/${choiceNodes.length})`,
          detail: { done, total: choiceNodes.length },
        });
      }
    }),
  );
  return validate(spec as unknown as Record<string, unknown>);
}

async function testsPass(
  spec: PipelineSpec,
  model: string,
  chat: ReturnType<typeof provider>,
  track: Track,
): Promise<PipelineSpec> {
  const inputFields = Object.keys((spec.input?.properties as Record<string, unknown>) ?? {});
  const labelable = labelableOutputKeys(spec);
  const res = await chat.chat({
    model,
    system: TESTS_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          `Pipeline: ${spec.description ?? spec.id}`,
          '',
          'Spec:',
          '```yaml',
          specToYaml(spec),
          '```',
        ].join('\n'),
      },
    ],
    schema: {
      name: 'test_cases',
      schema: testsSchema(inputFields, labelable) as unknown as Record<string, unknown>,
    },
  });
  track(res.usage);
  const parsed = res.json as { tests?: TestCase[] };
  return { ...spec, tests: usableTests(spec, parsed?.tests ?? []).slice(0, 30) };
}

/**
 * Keeps only the generated cases the pipeline can actually run.
 *
 * The schema asks for every input field, but a model is free to ignore it, and
 * a case whose input fails the pipeline's own input schema never reaches a
 * model: `execute()` rejects it, so it counts as neither pass nor fail. Shipping
 * those in the spec is what turns a working pipeline into one that evaluates at
 * 0% forever. Dropping them early costs a few test cases and keeps the rest
 * meaningful.
 */
function usableTests(spec: PipelineSpec, tests: TestCase[]): TestCase[] {
  const validator = inputValidator(spec);
  if (!validator) return tests;
  const usable = tests.filter((t) => validator(t.input));
  if (usable.length < tests.length) {
    log.warn('dropped generated test cases that do not match the input schema', {
      pipeline: spec.id,
      dropped: tests.length - usable.length,
      kept: usable.length,
    });
  }
  return usable;
}

/**
 * Passes 4 and 5. The dry run is real decision-model traffic over the generated tests;
 * the repair loop feeds the confusion pairs back into the compiler. Capped at
 * two loops, as the spec requires.
 */
async function maybeDryRun(
  spec: PipelineSpec,
  input: CompileInput,
  compileId: string,
  pipelineId: string,
  passIndex: number,
  totalPasses: number,
): Promise<PipelineSpec> {
  if (input.skipDryRun || !(spec.tests?.length)) return spec;

  let working = spec;
  const chat = provider();
  const model = input.compilerModel ?? config.defaultCompilerModel;

  for (let loop = 0; loop <= 2; loop++) {
    const row = await repo.getCompileRun(compileId);
    const cachedKey = loop === 0 ? 'dry_run' : 'repair';
    const cached = loop === 0 ? completed<{ spec: PipelineSpec; accuracy: number | null }>(row, 'dry_run') : null;
    if (cached) {
      working = cached.spec;
      if (cached.accuracy !== null && cached.accuracy >= 0.9) return working;
    }

    await emit(compileId, pipelineId, {
      pass: loop === 0 ? 'dry_run' : 'repair',
      index: loop === 0 ? passIndex : totalPasses,
      of: totalPasses,
      message: loop === 0 ? 'dry run' : `repair loop ${loop} of 2`,
    });

    const report = await dryRun(working, compileId, pipelineId, passIndex, totalPasses);
    await repo.savePass(compileId, cachedKey, { accuracy: report.accuracy, spec: working });

    await emit(compileId, pipelineId, {
      pass: 'dry_run',
      index: passIndex,
      of: totalPasses,
      message: `dry run: ${report.passed}/${report.total} correct`,
      detail: { accuracy: report.accuracy, confusions: report.confusions.length },
    });

    // Good enough, nothing actionable to repair, or nothing answered at all —
    // repairing definitions with no answers to learn from would spend a model
    // call rewriting a spec on no evidence.
    if (report.accuracy === null || report.accuracy >= 0.9 || report.confusions.length === 0 || loop === 2) {
      return working;
    }

    working = await repairPass(working, report.confusions, model, chat);
  }
  return working;
}

interface Confusion {
  node: string;
  expected: string;
  actual: string;
  input: string;
}

async function dryRun(
  spec: PipelineSpec,
  compileId: string,
  pipelineId: string,
  passIndex: number,
  totalPasses: number,
): Promise<{
  /** Over the cases that reached the model; null when none did. */
  accuracy: number | null;
  passed: number;
  total: number;
  errored: number;
  confusions: Confusion[];
}> {
  const tests = spec.tests ?? [];
  const confusions: Confusion[] = [];
  let passed = 0;
  let errored = 0;
  const settings = resolveSettings(spec);

  for (const [index, test] of tests.entries()) {
    try {
      const result = await execute({
        spec,
        version: 0,
        input: test.input,
        provider: provider(),
        settings,
      });
      const ok = Object.entries(test.expect).every(([key, want]) =>
        matchesExpectation(want, result.output[key]),
      );
      if (ok) passed++;
      else {
        for (const [key, want] of Object.entries(test.expect)) {
          if (matchesExpectation(want, result.output[key])) continue;
          const got = String(result.output[key] ?? '');
          // Attribute the miss to the node that produced this output key.
          const node = nodeForOutputKey(spec, key);
          if (node) {
            confusions.push({
              node,
              expected: String(want),
              actual: got,
              input: typeof test.input === 'string' ? test.input : JSON.stringify(test.input),
            });
          }
        }
      }
    } catch (err) {
      // A case that throws never reached a model, so it is not evidence about
      // the pipeline's accuracy — it is evidence the case itself is unusable.
      // Counted separately and reported, because a run where every case threw
      // and a run where the model got everything wrong both score 0.
      errored++;
      log.warn('dry run case failed', { error: (err as Error).message });
    }
    if ((index + 1) % 5 === 0 || index === tests.length - 1) {
      await emit(compileId, pipelineId, {
        pass: 'dry_run',
        index: passIndex,
        of: totalPasses,
        message:
          `dry run: ${passed}/${index + 1} correct` +
          (errored ? ` (${errored} could not run)` : ''),
        detail: { done: index + 1, total: tests.length, passed, errored },
      });
    }
  }
  if (errored === tests.length && tests.length > 0) {
    log.warn('every dry run case failed to execute', { pipeline: pipelineId, cases: tests.length });
  }
  const answered = tests.length - errored;
  return {
    accuracy: tests.length === 0 ? 1 : answered > 0 ? passed / answered : null,
    passed,
    total: tests.length,
    errored,
    confusions,
  };
}

/** Which node's answer feeds an output key, used to attribute a miss. */
function nodeForOutputKey(spec: PipelineSpec, key: string): string | null {
  const mapping = spec.output[key];
  if (typeof mapping !== 'string') return null;
  const first = mapping.split(/[^a-zA-Z0-9_]/)[0];
  return first in spec.nodes ? first : null;
}

async function repairPass(
  spec: PipelineSpec,
  confusions: Confusion[],
  model: string,
  chat: ReturnType<typeof provider>,
): Promise<PipelineSpec> {
  const byNode = new Map<string, Confusion[]>();
  for (const c of confusions) {
    if (!byNode.has(c.node)) byNode.set(c.node, []);
    byNode.get(c.node)!.push(c);
  }

  const repaired: PipelineSpec = structuredClone(spec);
  for (const [nodeId, nodeConfusions] of byNode) {
    const node = repaired.nodes[nodeId];
    if (!node || node.type !== 'choice') continue;
    const options = Object.keys(node.criteria);
    try {
      const res = await chat.chat({
        model,
        system: REPAIR_SYSTEM,
        messages: [
          { role: 'user', content: repairUser(nodeId, node.instructions, nodeConfusions, node.criteria) },
        ],
        schema: {
          name: 'repaired_options',
          schema: sharpenSchema(options) as unknown as Record<string, unknown>,
        },
      });
      const parsed = res.json as { options?: { name: string; what: string; not_for?: string; examples?: string[] }[] };
      for (const option of parsed?.options ?? []) {
        if (!(option.name in node.criteria)) continue;
        node.criteria[option.name] = {
          what: option.what,
          ...(option.not_for ? { not_for: option.not_for } : {}),
          ...(option.examples?.length ? { examples: option.examples.slice(0, 3) } : {}),
        };
      }
    } catch (err) {
      log.warn('repair failed for a node', { node: nodeId, error: (err as Error).message });
    }
  }
  return validate(repaired as unknown as Record<string, unknown>);
}

export { diffSpecs } from './diff.js';
