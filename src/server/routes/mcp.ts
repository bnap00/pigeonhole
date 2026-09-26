/**
 * MCP over Streamable HTTP at /mcp, at the same origin as the API. Each
 * published pipeline is a tool; callers authenticate like any API client.
 */
import type { FastifyInstance } from 'fastify';
import { authGuard } from '../app.js';
import { requireScope } from '../auth.js';
import { handleRpc, listTools, MCP_PROTOCOL_VERSION, type JsonRpcRequest } from '../../mcp/server.js';
import { config } from '../../config.js';

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/mcp')) return;
    await authGuard(req, reply);
    requireScope(req.identity, 'classify');
  });

  app.post<{ Body: JsonRpcRequest | JsonRpcRequest[] }>('/mcp', async (req, reply) => {
    const body = req.body;

    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map(handleRpc))).filter((r) => r !== null);
      if (responses.length === 0) {
        reply.code(202);
        return null;
      }
      return responses;
    }

    const response = await handleRpc(body);
    if (response === null) {
      // A notification. Accepted, no body.
      reply.code(202);
      return null;
    }
    return response;
  });

  /** Discovery for clients that GET before they POST. */
  app.get('/mcp', async () => ({
    name: 'pigeonhole',
    version: config.version,
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: 'streamable-http',
    endpoint: '/mcp',
    tools: (await listTools()).length,
  }));
}
