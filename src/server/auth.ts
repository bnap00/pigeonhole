/**
 * Bearer-token auth.
 *
 * Two kinds of credential: the admin token from the environment, which the UI
 * and CLI use for the control plane, and hashed API keys with scopes and a
 * per-pipeline allow-list, which callers use for classify. Every endpoint
 * except health needs one; the app refuses to start without an admin token.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { problem } from '../errors.js';
import * as repo from '../db/repo.js';

export interface Identity {
  kind: 'admin' | 'key';
  keyId?: string;
  name: string;
  scopes: string[];
  /** null means every pipeline. */
  pipelines: string[] | null;
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function lookupKey(token: string): Promise<Identity | null> {
  const row = await repo.findApiKey(token);
  if (!row) return null;
  void repo.touchApiKey(row.id).catch(() => undefined);
  return { kind: 'key', keyId: row.id, name: row.name, scopes: row.scopes, pipelines: row.pipelines };
}

export async function authenticate(req: FastifyRequest): Promise<Identity> {
  const token = bearerToken(req);

  if (!token) throw problem('unauthorized', 'this endpoint needs a bearer token');
  if (config.adminToken && constantTimeEquals(token, config.adminToken)) {
    return { kind: 'admin', name: 'admin token', scopes: ['classify', 'admin'], pipelines: null };
  }
  const identity = await lookupKey(token);
  if (identity) return identity;
  throw problem('unauthorized', 'the bearer token is not a valid API key');
}

export function requireScope(identity: Identity, scope: 'classify' | 'admin'): void {
  if (identity.scopes.includes(scope)) return;
  throw problem('forbidden', `this key does not have the "${scope}" scope`);
}

export function requirePipelineAccess(identity: Identity, pipelineId: string): void {
  if (identity.pipelines === null) return;
  if (identity.pipelines.includes(pipelineId)) return;
  throw problem('forbidden', `this key is not allowed to use pipeline "${pipelineId}"`);
}
