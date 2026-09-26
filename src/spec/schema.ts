/** JSON Schema for the pipeline spec. Published so specs can be validated anywhere. */

export const SPEC_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://pigeonhole.dev/schema/pipeline-v1.json',
  title: 'Pigeonhole pipeline spec',
  type: 'object',
  required: ['pigeonhole', 'id', 'nodes', 'output'],
  additionalProperties: false,
  properties: {
    pigeonhole: { const: 1 },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
    version: { type: 'integer', minimum: 1 },
    description: { type: 'string', maxLength: 8000 },
    input: { type: 'object' },
    model: {
      type: 'object',
      additionalProperties: false,
      properties: { runtime: { type: 'string' }, compiler: { type: 'string' } },
    },
    nodes: {
      type: 'object',
      minProperties: 1,
      propertyNames: { pattern: '^[a-zA-Z_][a-zA-Z0-9_]{0,63}$' },
      additionalProperties: { $ref: '#/$defs/node' },
    },
    output: {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        oneOf: [
          { type: 'string' },
          { type: 'object', required: ['const'], additionalProperties: false, properties: { const: {} } },
        ],
      },
    },
    tests: { type: 'array', items: { $ref: '#/$defs/test' } },
    compose: { $ref: '#/$defs/compose' },
  },
  $defs: {
    criterion: {
      oneOf: [
        { type: 'null' },
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
        {
          type: 'object',
          properties: {
            what: { type: 'string' },
            not_for: { type: 'string' },
            examples: { type: 'array', items: { type: 'string' } },
          },
        },
      ],
    },
    lowConfidence: {
      type: 'string',
      pattern: '^(human_review|error|default:.+)$',
    },
    node: {
      type: 'object',
      required: ['type'],
      properties: {
        type: { enum: ['choice', 'score', 'noul', 'rule'] },
        when: { type: 'string', maxLength: 2000 },
        lazy: { type: 'boolean' },
        description: { type: 'string' },
        instructions: { type: 'string', minLength: 1, maxLength: 4000 },
        criteria: {
          type: 'object',
          minProperties: 2,
          maxProperties: 255,
          propertyNames: { pattern: '^[^\\s].{0,127}$' },
          additionalProperties: { $ref: '#/$defs/criterion' },
        },
        scale: {
          type: 'object',
          required: ['min', 'max'],
          properties: {
            min: { type: 'number' },
            max: { type: 'number' },
            labels: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
        min_confidence: { type: 'number', minimum: 0, maximum: 1 },
        on_low_confidence: { $ref: '#/$defs/lowConfidence' },
        also_above: { type: 'number', minimum: 0, maximum: 1 },
        expr: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      allOf: [
        {
          if: { properties: { type: { const: 'choice' } } },
          then: { required: ['instructions', 'criteria'] },
        },
        {
          if: { properties: { type: { const: 'score' } } },
          then: { required: ['instructions', 'scale'] },
        },
        {
          if: { properties: { type: { const: 'noul' } } },
          then: { required: ['instructions'] },
        },
        {
          if: { properties: { type: { const: 'rule' } } },
          then: { required: ['expr'] },
        },
      ],
    },
    test: {
      type: 'object',
      required: ['input', 'expect'],
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        input: { oneOf: [{ type: 'object' }, { type: 'string' }] },
        expect: { type: 'object', minProperties: 1 },
      },
    },
    compose: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cache: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { enum: ['off', 'memory'] },
            ttl: { type: 'integer', minimum: 1, maximum: 86400 },
          },
        },
        logging: {
          type: 'object',
          additionalProperties: false,
          properties: {
            telemetry: { enum: ['postgres', 'none'] },
            retain: { enum: ['all', 'sampled', 'low_confidence', 'none'] },
            sample_rate: { type: 'number', minimum: 0, maximum: 1 },
            retention_days: { type: 'integer', minimum: 1, maximum: 3650 },
            input: { enum: ['full', 'hash_only', 'off'] },
            redact_pii: { type: 'boolean' },
          },
        },
      },
    },
  },
} as const;
