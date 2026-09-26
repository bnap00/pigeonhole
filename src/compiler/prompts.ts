/**
 * Compiler prompts and the JSON schemas that constrain each pass.
 *
 * Every pass asks for structured output against a strict schema, so a pass
 * either produces something parseable or fails loudly. That is what lets the
 * repair loop be about classification quality rather than about JSON.
 */

export const DRAFT_SYSTEM = `You design classification pipelines for Pigeonhole.

Pigeonhole runs each pipeline on a decision model (such as Jev), which answers typed questions about an input and returns calibrated probabilities. You do not write prompts; you write a precise specification of the decisions to make.

You have exactly four node types:
- choice: pick one of N named options. Returns the option, a probability for every option, and a confidence.
- score:  a number on a defined scale (for example 0 calm to 2 furious).
- noul:   the probability that a yes/no statement about the input is true.
- rule:   deterministic logic over other nodes' answers. No model call.

Rules you must follow:
- One node per decision. Do not merge two decisions into one option list.
- Option names are lowercase snake_case, stable, and meaningful on their own.
- Prefer few, well-separated options over many overlapping ones.
- Add an "other" option to any choice node whose options may not cover everything.
- A rule node's expr uses only: comparisons, && || !, ternary, arithmetic, and
  references like node_id.choice, node_id.p, node_id.confidence, node_id.score,
  node_id.low_confidence, and input.field. A bare node_id means its main answer.
- Node ids are snake_case identifiers.
- The input schema describes what callers send. Keep it small and obvious.`;

export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['input', 'nodes', 'output'],
  properties: {
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['properties', 'required'],
      properties: {
        properties: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'type', 'description'],
            properties: {
              name: { type: 'string' },
              type: { enum: ['string', 'number', 'boolean'] },
              description: { type: 'string' },
            },
          },
        },
        required: { type: 'array', items: { type: 'string' } },
      },
    },
    nodes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'type', 'purpose'],
        properties: {
          id: { type: 'string' },
          type: { enum: ['choice', 'score', 'noul', 'rule'] },
          purpose: { type: 'string' },
          instructions: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          scale_min: { type: 'number' },
          scale_max: { type: 'number' },
          scale_labels: { type: 'array', items: { type: 'string' } },
          expr: { type: 'string' },
          when: { type: 'string' },
          min_confidence: { type: 'number' },
          on_low_confidence: { type: 'string' },
        },
      },
    },
    output: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'expr'],
        properties: { key: { type: 'string' }, expr: { type: 'string' } },
      },
    },
  },
} as const;

export const draftUser = (description: string, samples: string[]): string =>
  [
    'Design a pipeline for this description:',
    '',
    description.trim(),
    ...(samples.length > 0
      ? ['', 'Sample inputs the caller expects to send:', ...samples.slice(0, 10).map((s) => `- ${s}`)]
      : []),
  ].join('\n');

export const SHARPEN_SYSTEM = `You sharpen the option definitions of a classification node so that neighbouring options separate cleanly.

For every option write:
- what:     what belongs here, concretely. One or two sentences.
- not_for:  what a reader might wrongly put here, naming the option it belongs
            in instead. Omit only when nothing plausibly confuses with it.
- examples: two or three short, realistic inputs that belong in this option.

The single most common failure is two options that sound different but overlap
in practice. Write not_for as if correcting that specific mistake.

Never rename, add or remove options. Return exactly the options you were given.`;

export const sharpenSchema = (options: string[]) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: ['options'],
    properties: {
      options: {
        type: 'array',
        minItems: options.length,
        maxItems: options.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'what', 'examples'],
          properties: {
            name: { enum: options },
            what: { type: 'string' },
            not_for: { type: 'string' },
            examples: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }) as const;

export const sharpenUser = (nodeId: string, instructions: string, options: string[], context: string): string =>
  [
    `Pipeline purpose: ${context}`,
    '',
    `Node "${nodeId}" asks: ${instructions}`,
    '',
    'Options to define:',
    ...options.map((o) => `- ${o}`),
  ].join('\n');

export const TESTS_SYSTEM = `You write labelled test cases for a classification pipeline.

Rules:
- Cover every option of every choice node at least once.
- Include edge cases that sit between two options, labelled with the answer you
  believe is correct. These are the cases that catch drift.
- Inputs must be realistic: the kind of text this pipeline will actually see,
  including messy ones.
- Only label what the input clearly determines.
- Yes/no keys are labelled "true" or "false": the answer the input plainly supports.
- Do not write two tests that differ only cosmetically.

You are only shown the output keys that can carry a stable label. Probability
and confidence outputs are deliberately absent: no one can say in advance that
an input deserves 0.83 rather than 0.86, and a test asserting it fails forever.`;

/**
 * The expectation schema is built from the spec, so the model can only label
 * keys that CAN be labelled, and can only use option names that exist.
 *
 * Strict structured-output mode requires every declared property, so a model
 * asked about a probability will invent one and every test will fail forever.
 * Excluding those keys here is what makes generated tests meaningful.
 *
 * Both nested objects list every property in `required`, and they have to.
 * Strict mode demands it, but the reason that matters is the pipeline's own
 * input schema: a generated case that omits a required input field is rejected
 * by `execute()` before any model is called, so it cannot pass, cannot fail
 * informatively, and lands as a bare error. A whole suite built that way
 * evaluates at exactly 0% accuracy while looking like a model problem.
 */
export const testsSchema = (
  inputFields: string[],
  labelable: Record<string, { type: 'enum' | 'number' | 'boolean' | 'any'; values?: string[] }>,
) => {
  const expectProperties: Record<string, unknown> = {};
  for (const [key, shape] of Object.entries(labelable)) {
    expectProperties[key] = shape.values ? { enum: shape.values } : { type: 'string' };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['tests'],
    properties: {
      tests: {
        type: 'array',
        minItems: 10,
        maxItems: 30,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'input', 'expect'],
          properties: {
            name: { type: 'string' },
            input: {
              type: 'object',
              additionalProperties: false,
              required: inputFields,
              properties: Object.fromEntries(inputFields.map((f) => [f, { type: 'string' }])),
            },
            expect: {
              type: 'object',
              additionalProperties: false,
              required: Object.keys(expectProperties),
              properties: expectProperties,
            },
          },
        },
      },
    },
  } as const;
};

export const REPAIR_SYSTEM = `You repair a classification node whose options are being confused with each other.

You are given the confusion pairs observed on a real dry run: inputs labelled A
that the model answered B. Rewrite ONLY the definitions of the options involved
so the boundary between them is unambiguous.

Make the boundary explicit in both directions: say in A's not_for what belongs
in B, and in B's not_for what belongs in A. Use the failing inputs to choose
wording that would have separated them.

Never rename, add or remove options.`;

export const repairUser = (
  nodeId: string,
  instructions: string,
  confusions: { expected: string; actual: string; input: string }[],
  current: Record<string, unknown>,
): string =>
  [
    `Node "${nodeId}" asks: ${instructions}`,
    '',
    'Current definitions:',
    JSON.stringify(current, null, 2),
    '',
    'Observed confusions (expected -> actual):',
    ...confusions.slice(0, 20).map((c) => `- ${c.expected} -> ${c.actual}: ${truncate(c.input, 220)}`),
  ].join('\n');

export const INCREMENTAL_SYSTEM = `You apply a small, targeted edit to an existing classification pipeline.

Change only what the instruction requires. Leave every other node, option,
definition and output key exactly as it is. If the edit adds or splits options,
write full definitions for the new ones and update the not_for of any option
they now border.`;

export const incrementalUser = (specYaml: string, instruction: string): string =>
  ['Current spec:', '', '```yaml', specYaml, '```', '', `Edit to apply: ${instruction}`].join('\n');

export const INCREMENTAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['spec_yaml', 'summary'],
  properties: {
    spec_yaml: { type: 'string' },
    summary: { type: 'string' },
  },
} as const;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
