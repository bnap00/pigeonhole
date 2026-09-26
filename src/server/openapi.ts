/**
 * A typed OpenAPI 3.1 document per pipeline.
 *
 * The output schema is derived from the spec, so a caller's generated client
 * knows that `team` is `"returns" | "shipping" | "billing" | "other"` and the
 * compiler in their language checks it.
 */
import type { PipelineSpec } from '../spec/types.js';
import { config } from '../config.js';

function outputSchemaFor(spec: PipelineSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const [key, mapping] of Object.entries(spec.output)) {
    if (typeof mapping !== 'string') {
      properties[key] = { description: 'constant' };
      continue;
    }
    const [nodeId, field] = mapping.split('.');
    const node = spec.nodes[nodeId];
    if (!node) {
      properties[key] = {};
      continue;
    }
    if (node.type === 'choice' && (field === 'choice' || field === undefined)) {
      // The whole point of the generated client: a real union type.
      properties[key] = { type: ['string', 'null'], enum: [...Object.keys(node.criteria), null] };
    } else if (node.type === 'choice' && field === 'low_confidence') {
      properties[key] = { type: 'boolean' };
    } else if (node.type === 'choice' && field === 'confidence') {
      properties[key] = { type: 'number', minimum: 0, maximum: 1 };
    } else if (node.type === 'noul') {
      properties[key] = { type: ['number', 'null'], minimum: 0, maximum: 1 };
    } else if (node.type === 'score') {
      properties[key] = { type: ['number', 'null'], minimum: node.scale.min, maximum: node.scale.max };
    } else {
      properties[key] = {};
    }
  }
  return { type: 'object', properties, required: Object.keys(spec.output) };
}

function nodesSchemaFor(spec: PipelineSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.type === 'choice') {
      properties[id] = {
        type: 'object',
        properties: {
          choice: { enum: Object.keys(node.criteria) },
          confidence: { type: 'number' },
          probabilities: {
            type: 'object',
            properties: Object.fromEntries(Object.keys(node.criteria).map((o) => [o, { type: 'number' }])),
          },
          low_confidence: { type: 'boolean' },
          also: { type: 'array', items: { enum: Object.keys(node.criteria) } },
        },
      };
    } else if (node.type === 'noul') {
      properties[id] = { type: 'object', properties: { p: { type: 'number' }, confidence: { type: 'number' } } };
    } else if (node.type === 'score') {
      properties[id] = {
        type: 'object',
        properties: {
          score: { type: 'number', minimum: node.scale.min, maximum: node.scale.max },
          confidence: { type: 'number' },
        },
      };
    } else {
      properties[id] = { type: 'object', properties: { value: {} } };
    }
  }
  return { type: 'object', properties };
}

export function openApiFor(spec: PipelineSpec, version: number): Record<string, unknown> {
  const server = config.publicUrl;
  const inputSchema = spec.input ?? { type: 'object' };

  return {
    openapi: '3.1.0',
    info: {
      title: `Pigeonhole: ${spec.id}`,
      version: String(version),
      description: spec.description ?? `Classification endpoint for ${spec.id}.`,
    },
    servers: [{ url: server }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'A Pigeonhole API key with the classify scope.' },
      },
      schemas: {
        Input: inputSchema,
        Output: outputSchemaFor(spec),
        Nodes: nodesSchemaFor(spec),
        Problem: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            code: { type: 'string' },
          },
        },
        ClassifyResponse: {
          type: 'object',
          required: ['run_id', 'pipeline', 'version', 'output'],
          properties: {
            run_id: { type: 'string' },
            pipeline: { type: 'string', const: spec.id },
            version: { type: 'integer' },
            output: { $ref: '#/components/schemas/Output' },
            nodes: { $ref: '#/components/schemas/Nodes' },
            model: { type: 'string' },
            usage: {
              type: 'object',
              properties: {
                input_tokens: { type: 'integer' },
                decision_calls: { type: 'integer' },
              },
            },
            latency_ms: { type: 'integer' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      [`/v1/classify/${spec.id}`]: {
        post: {
          summary: `Classify one input against ${spec.id}`,
          operationId: `classify_${spec.id.replace(/-/g, '_')}`,
          parameters: [
            {
              name: 'detail',
              in: 'query',
              schema: { enum: ['full', 'output'] },
              description: 'Set to `output` to drop the per-node detail from the response.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['input'],
                  properties: { input: { $ref: '#/components/schemas/Input' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The classification result',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ClassifyResponse' } } },
            },
            '400': problemResponse('The input did not match the pipeline input schema'),
            '422': problemResponse('A node answered below its min_confidence and on_low_confidence is `error`'),
            '429': problemResponse('Rate limited'),
            '502': problemResponse('The model provider failed'),
          },
        },
      },
      [`/v1/classify/${spec.id}/batch`]: {
        post: {
          summary: `Classify many inputs against ${spec.id}`,
          description:
            'Unbounded. Inputs are processed with a concurrency limit; the only ceiling is the request body cap.',
          operationId: `classify_${spec.id.replace(/-/g, '_')}_batch`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['inputs'],
                  properties: { inputs: { type: 'array', items: { $ref: '#/components/schemas/Input' } } },
                },
              },
            },
          },
          responses: { '200': { description: 'Per-input results' } },
        },
      },
      [`/v1/classify/${spec.id}/async`]: {
        post: {
          summary: `Queue a classification and deliver the result to a webhook`,
          operationId: `classify_${spec.id.replace(/-/g, '_')}_async`,
          responses: { '202': { description: 'Queued' } },
        },
      },
    },
  };
}

const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});
