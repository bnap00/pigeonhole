/** The control plane: pipelines, drafts, versions, test cases, OpenAPI. */
import type { FastifyInstance } from 'fastify';
import { authGuard } from '../app.js';
import { requireScope } from '../auth.js';
import * as repo from '../../db/repo.js';
import { lint, parseSpecYaml, resolveSettings, specToYaml, validate } from '../../spec/parse.js';
import type { PipelineSpec } from '../../spec/types.js';
import { invalidateSpec } from '../../cache/specs.js';
import { problem } from '../../errors.js';
import { enqueue } from '../../queue/index.js';
import { openApiFor } from '../openapi.js';
import { diffSpecs } from '../../compiler/diff.js';
import { classify } from '../../runtime/classify.js';
import { execute } from '../../executor/execute.js';
import { provider } from '../../provider/index.js';

/** Request bodies arrive unvalidated; each handler checks what it needs. */
type Body = Record<string, any>;

/** The UI posts YAML; the CLI and SDKs post JSON. Both land here. */
function specFromBody(body: Body): PipelineSpec {
  if (typeof body?.spec_yaml === 'string') return parseSpecYaml(body.spec_yaml);
  if (body?.spec && typeof body.spec === 'object') return validate(body.spec);
  throw problem('input_invalid', 'send either `spec_yaml` (a YAML string) or `spec` (an object)');
}

export async function registerPipelineRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/pipelines')) return;
    await authGuard(req, reply);
    requireScope(req.identity, 'admin');
  });

  app.get('/v1/pipelines', async () => {
    const pipelines = await repo.listPipelines();
    return {
      pipelines: pipelines.map((p) => ({
        id: p.id,
        description: p.description,
        latest_version: p.latest_version,
        pinned_version: p.pinned_version,
        versions: p.version_count,
        has_draft: Boolean(p.draft_spec),
        updated_at: p.updated_at,
      })),
    };
  });

  app.post<{ Body: Body }>('/v1/pipelines', async (req, reply) => {
    const id = String(req.body?.id ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
      throw problem('input_invalid', 'id must be lowercase letters, digits and hyphens');
    }
    if (await repo.getPipeline(id)) throw problem('conflict', `pipeline "${id}" already exists`);

    const spec = req.body?.spec || req.body?.spec_yaml ? specFromBody(req.body) : null;
    if (spec && spec.id !== id) spec.id = id;

    const pipeline = await repo.createPipeline({
      id,
      description: req.body?.description ?? spec?.description ?? '',
      draft_spec: spec,
      owner: req.identity.name,
    });
    reply.code(201);
    return { pipeline };
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/v1/pipelines/:id',
    async (req) => {
      const pipeline = await repo.requirePipeline(req.params.id);
      const versions = await repo.listVersions(req.params.id, 20);
      const draft = pipeline.draft_spec as PipelineSpec | null;
      const latest = versions[0]?.spec ?? null;
      const serving = versions.length ? await repo.resolveServingVersion(req.params.id) : null;
      const runtimeSpec = serving?.spec ?? draft;
      const working = draft || latest ? await repo.resolveWorkingSpec(req.params.id) : null;

      return {
        pipeline: {
          id: pipeline.id,
          description: pipeline.description,
          pinned_version: pipeline.pinned_version,
          owner: pipeline.owner,
          updated_at: pipeline.updated_at,
          /** The decision model live traffic runs on: the served version's, else the draft's. */
          runtime_model: runtimeSpec ? resolveSettings(runtimeSpec as PipelineSpec).runtimeModel : null,
        },
        draft: draft,
        /** What "Try it" and the builder's evals run: the draft if it has unpublished changes, else the latest version. */
        working: working ? { source: working.source, version: working.version } : null,
        draft_yaml: draft ? specToYaml(draft) : null,
        lint: draft ? lint(draft) : [],
        /** What a save would change, so the UI never publishes blind. */
        unpublished_diff: draft && latest ? diffSpecs(latest, draft) : null,
        versions: versions.map((v) => ({
          version: v.version,
          created_at: v.created_at,
          created_by: v.created_by,
          eval_summary: v.eval_summary,
          notes: v.notes,
        })),
        test_cases: await repo.listTestCases(req.params.id),
      };
    },
  );

  /**
   * The builder's "Try it": one input through the working spec (see
   * `resolveWorkingSpec`). A published version goes through the runtime path,
   * so the run is recorded like any other; a draft is executed directly and
   * leaves no trace in runs or analytics.
   */
  app.post<{ Params: { id: string }; Body: Body }>('/v1/pipelines/:id/try', async (req) => {
    if (req.body?.input === undefined) throw problem('input_invalid', 'request body must contain `input`');
    const working = await repo.resolveWorkingSpec(req.params.id);
    if (working.source === 'version') {
      const result = await classify({ pipelineId: req.params.id, version: working.version, input: req.body.input });
      return { target: `v${working.version}`, ...result };
    }
    const result = await execute({ spec: working.spec, version: 0, input: req.body.input, provider: provider() });
    return { target: 'draft', ...result };
  });

  app.put<{ Params: { id: string }; Body: Body }>('/v1/pipelines/:id', async (req) => {
    await repo.requirePipeline(req.params.id);
    const spec = specFromBody(req.body);
    if (spec.id !== req.params.id) spec.id = req.params.id;
    const updated = await repo.updateDraft(req.params.id, spec, spec.description);
    return { pipeline: updated, lint: lint(spec), draft_yaml: specToYaml(spec) };
  });

  app.delete<{ Params: { id: string } }>('/v1/pipelines/:id', async (req) => {
    await repo.requirePipeline(req.params.id);
    await repo.archivePipeline(req.params.id);
    await invalidateSpec(req.params.id);
    return { archived: req.params.id };
  });

  /**
   * Publish. Postgres commit, then a bus invalidation, so the next classify
   * serves the new version with no propagation window.
   */
  app.post<{ Params: { id: string }; Body: Body }>('/v1/pipelines/:id/versions', async (req, reply) => {
    const pipeline = await repo.requirePipeline(req.params.id);
    const spec = req.body?.spec || req.body?.spec_yaml
      ? specFromBody(req.body)
      : (pipeline.draft_spec as PipelineSpec | null);
    if (!spec) throw problem('conflict', 'there is no draft spec to publish');
    if (spec.id !== req.params.id) spec.id = req.params.id;

    const version = await repo.publishVersion(req.params.id, spec, req.identity.name, req.body?.notes);
    await invalidateSpec(req.params.id, version.version);

    // Advisory eval on save, as the spec requires. Non-blocking.
    await enqueue('eval', { pipeline: req.params.id, version: version.version, trigger: 'save' });

    reply.code(201);
    return { version: version.version, created_at: version.created_at, spec: version.spec };
  });

  app.get<{ Params: { id: string; version: string } }>(
    '/v1/pipelines/:id/versions/:version',
    async (req) => {
      const version = await repo.getVersion(req.params.id, Number(req.params.version));
      if (!version) throw problem('version_not_found', `no version ${req.params.version}`);
      return { version: version.version, spec: version.spec, spec_yaml: specToYaml(version.spec) };
    },
  );

  /** Pin the serving version, or unpin to follow latest. */
  app.post<{ Params: { id: string }; Body: { version: number | null } }>(
    '/v1/pipelines/:id/pin',
    async (req) => {
      await repo.requirePipeline(req.params.id);
      const version = req.body?.version ?? null;
      if (version !== null && !(await repo.getVersion(req.params.id, version))) {
        throw problem('version_not_found', `no version ${version}`);
      }
      const pipeline = await repo.setPinnedVersion(req.params.id, version);
      await invalidateSpec(req.params.id);
      return { pinned_version: pipeline?.pinned_version ?? null };
    },
  );

  // -------------------------------------------------------------- test cases

  app.post<{ Params: { id: string }; Body: Body }>('/v1/pipelines/:id/tests', async (req, reply) => {
    await repo.requirePipeline(req.params.id);
    if (req.body?.input === undefined || !req.body?.expect) {
      throw problem('input_invalid', 'a test case needs `input` and `expect`');
    }
    const row = await repo.addTestCase(
      req.params.id,
      { name: req.body.name, input: req.body.input, expect: req.body.expect },
      req.body.source ?? 'manual',
    );
    reply.code(201);
    return { test: row };
  });

  app.delete<{ Params: { id: string; testId: string } }>(
    '/v1/pipelines/:id/tests/:testId',
    async (req) => {
      await repo.deleteTestCase(req.params.id, Number(req.params.testId));
      return { deleted: Number(req.params.testId) };
    },
  );

  // ------------------------------------------------------------- shadow mode

  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/v1/pipelines/:id/shadow',
    async (req) => {
      await repo.requirePipeline(req.params.id);
      await repo.setMeta(`shadow:${req.params.id}`, Boolean(req.body?.enabled));
      const { clearShadowCache } = await import('../../runtime/classify.js');
      clearShadowCache();
      const agreement = await repo.shadowAgreement(req.params.id);
      return { enabled: Boolean(req.body?.enabled), agreement };
    },
  );

  app.get<{ Params: { id: string } }>('/v1/pipelines/:id/shadow', async (req) => {
    const enabled = Boolean(await repo.getMeta<boolean>(`shadow:${req.params.id}`));
    return { enabled, agreement: await repo.shadowAgreement(req.params.id) };
  });

  // ----------------------------------------------------------------- OpenAPI

  app.get<{ Params: { id: string } }>('/v1/pipelines/:id/openapi.json', async (req) => {
    const serving = await repo.resolveServingVersion(req.params.id);
    return openApiFor(serving.spec, serving.version);
  });
}
