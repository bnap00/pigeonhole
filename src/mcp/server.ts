/**
 * MCP server core, shared by the HTTP transport (`/mcp`) and stdio
 * (`pigeonhole mcp`).
 *
 * Each published pipeline becomes exactly one tool: the name comes from the
 * slug, the description from the pipeline description, the input schema from
 * the spec's `input`, and the result is the classify response. Agents get a
 * cheap, calibrated decision instead of spending reasoning tokens on it.
 */
import * as repo from '../db/repo.js';
import { classify } from '../runtime/classify.js';
import { loadSpec } from '../cache/specs.js';
import { config } from '../config.js';
import { log } from '../log.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const toolName = (pipelineId: string) => `classify_${pipelineId.replace(/-/g, '_')}`;
const pipelineFromTool = (tool: string) => tool.replace(/^classify_/, '').replace(/_/g, '-');

export async function listTools(): Promise<unknown[]> {
  const pipelines = await repo.listPipelines();
  const tools: unknown[] = [];

  for (const pipeline of pipelines) {
    if (!pipeline.latest_version) continue;            // drafts are not tools
    try {
      const { spec } = await loadSpec(pipeline.id);
      tools.push({
        name: toolName(pipeline.id),
        title: pipeline.id,
        description:
          (pipeline.description || `Classify an input with the ${pipeline.id} pipeline.`).trim() +
          `\n\nReturns: ${Object.keys(spec.output).join(', ')}.`,
        inputSchema: spec.input ?? { type: 'object', properties: {}, additionalProperties: true },
      });
    } catch (err) {
      log.debug('skipped a pipeline in the MCP tool list', { pipeline: pipeline.id, error: (err as Error).message });
    }
  }
  return tools;
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const pipelineId = pipelineFromTool(name);
  const result = await classify({ pipelineId, input: args });
  return {
    content: [{ type: 'text', text: JSON.stringify(result.output, null, 2) }],
    structuredContent: {
      output: result.output,
      nodes: result.nodes,
      run_id: result.run_id,
      version: result.version,
      model: result.model,
    },
  };
}

export async function handleRpc(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  try {
    switch (req.method) {
      case 'initialize':
        return ok({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pigeonhole', version: config.version },
          instructions:
            'Each tool classifies one input with a Pigeonhole pipeline and returns a typed decision ' +
            'with calibrated probabilities. Prefer these over reasoning about the category yourself.',
        });

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;                                    // notifications get no reply

      case 'ping':
        return ok({});

      case 'tools/list':
        return ok({ tools: await listTools() });

      case 'tools/call': {
        const name = String(req.params?.name ?? '');
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        if (!name) return fail(-32602, 'tools/call needs a tool name');
        try {
          return ok(await callTool(name, args));
        } catch (err) {
          // A failed classification is a tool error, not a protocol error:
          // the agent should see it and be able to react.
          return ok({
            content: [{ type: 'text', text: `Classification failed: ${(err as Error).message}` }],
            isError: true,
          });
        }
      }

      default:
        return fail(-32601, `unknown method "${req.method}"`);
    }
  } catch (err) {
    log.warn('mcp request failed', { method: req.method, error: (err as Error).message });
    return fail(-32603, (err as Error).message);
  }
}

/** stdio transport for `pigeonhole mcp`, for agents running on the same box. */
export async function serveStdio(): Promise<void> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, terminal: false });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
      );
      continue;
    }
    const response = await handleRpc(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
