/** API keys, webhooks, the template gallery, and the operator's health check. */
import type { FastifyInstance } from 'fastify';
import { authGuard } from '../app.js';
import { requireScope } from '../auth.js';
import * as repo from '../../db/repo.js';
import { problem } from '../../errors.js';
import { templates } from '../../seed.js';
import { query } from '../../db/pool.js';
import { schemaIsCurrent } from '../../db/migrate.js';
import { providerCheck, type Check } from '../../ops/status.js';

type Body = Record<string, any>;

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!/^\/v1\/(keys|webhooks|templates|check)/.test(req.url)) return;
    await authGuard(req, reply);
    requireScope(req.identity, 'admin');
  });

  // ----------------------------------------------------------------- check

  /**
   * Everything an operator needs in one call, and what `make check` prints.
   * Unlike /readyz, this asks the provider for a real answer, so it is
   * authenticated and not used by the container healthcheck:
   * OpenRouter being down should not restart the app.
   */
  app.get('/v1/check', async () => {
    const checks: Check[] = [];
    try {
      await query('SELECT 1');
      checks.push({ name: 'database', state: 'ok', detail: 'reachable' });
    } catch (err) {
      checks.push({ name: 'database', state: 'fail', detail: (err as Error).message });
    }
    const current = await schemaIsCurrent().catch(() => false);
    checks.push(
      current
        ? { name: 'migrations', state: 'ok', detail: 'schema is current' }
        : { name: 'migrations', state: 'fail', detail: 'migrations have not finished', fix: 'make logs' },
    );
    checks.push(await providerCheck());
    return { healthy: checks.every((c) => c.state !== 'fail'), checks };
  });

  // -------------------------------------------------------------- API keys

  app.get('/v1/keys', async () => ({ keys: await repo.listApiKeys() }));

  app.post<{ Body: Body }>('/v1/keys', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw problem('input_invalid', 'a key needs a name');
    const scopes: string[] = req.body?.scopes ?? ['classify'];
    for (const scope of scopes) {
      if (scope !== 'classify' && scope !== 'admin') {
        throw problem('input_invalid', `"${scope}" is not a scope; use classify or admin`);
      }
    }
    const { key, row } = await repo.createApiKey({
      name,
      scopes,
      pipelines: req.body?.pipelines ?? null,
    });
    reply.code(201);
    // The only time the secret is ever returned. It is stored hashed.
    return {
      key,
      warning: 'This is the only time this key is shown. Store it now.',
      id: row.id,
      name: row.name,
      scopes: row.scopes,
      pipelines: row.pipelines,
    };
  });

  app.delete<{ Params: { id: string } }>('/v1/keys/:id', async (req) => {
    const revoked = await repo.revokeApiKey(req.params.id);
    if (!revoked) throw problem('pipeline_not_found', 'no such API key');
    return { revoked: req.params.id };
  });

  // -------------------------------------------------------------- webhooks

  app.post<{ Body: Body }>('/v1/webhooks', async (req, reply) => {
    if (!req.body?.url) throw problem('input_invalid', 'a webhook needs a url');
    const row = await repo.addWebhook({
      pipelineId: req.body.pipeline ?? null,
      url: req.body.url,
      event: req.body.event ?? 'drift',
      secret: req.body.secret,
    });
    reply.code(201);
    return { webhook_id: row!.id };
  });

  // ------------------------------------------------------------- templates

  app.get('/v1/templates', async () => ({
    templates: templates().map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      spec_yaml: t.yaml,
    })),
  }));
}
