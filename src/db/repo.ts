/** Every Postgres read and write the application makes, in one place. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, query, rows, tx } from './pool.js';
import type { PipelineSpec, TestCase } from '../spec/types.js';
import type { RunResult } from '../executor/types.js';
import { problem } from '../errors.js';

export interface PipelineRow {
  id: string;
  description: string;
  draft_spec: PipelineSpec | null;
  pinned_version: number | null;
  owner: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export interface VersionRow {
  pipeline_id: string;
  version: number;
  spec: PipelineSpec;
  created_by: string;
  created_at: Date;
  eval_summary: Record<string, unknown> | null;
  notes: string | null;
}

// ---------------------------------------------------------------- pipelines

export const listPipelines = () =>
  rows<PipelineRow & { latest_version: number | null; version_count: number }>(
    `SELECT p.*,
            (SELECT max(version) FROM versions v WHERE v.pipeline_id = p.id) AS latest_version,
            (SELECT count(*) FROM versions v WHERE v.pipeline_id = p.id) AS version_count
       FROM pipelines p
      WHERE p.archived_at IS NULL
      ORDER BY p.updated_at DESC`,
  );

export const getPipeline = (id: string) =>
  one<PipelineRow>('SELECT * FROM pipelines WHERE id = $1 AND archived_at IS NULL', [id]);

export async function requirePipeline(id: string): Promise<PipelineRow> {
  const p = await getPipeline(id);
  if (!p) throw problem('pipeline_not_found', `no pipeline with id "${id}"`);
  return p;
}

export const createPipeline = (input: {
  id: string;
  description?: string;
  draft_spec?: PipelineSpec | null;
  owner?: string;
}) =>
  one<PipelineRow>(
    `INSERT INTO pipelines (id, description, draft_spec, owner)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      input.id,
      input.description ?? '',
      input.draft_spec ? JSON.stringify(input.draft_spec) : null,
      input.owner ?? 'local',
    ],
  );

export const updateDraft = (id: string, spec: PipelineSpec | null, description?: string) =>
  one<PipelineRow>(
    `UPDATE pipelines
        SET draft_spec = $2,
            description = COALESCE($3, description),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, spec ? JSON.stringify(spec) : null, description ?? null],
  );

export const setPinnedVersion = (id: string, version: number | null) =>
  one<PipelineRow>(
    'UPDATE pipelines SET pinned_version = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, version],
  );

export const archivePipeline = (id: string) =>
  query('UPDATE pipelines SET archived_at = now() WHERE id = $1', [id]);

// ----------------------------------------------------------------- versions

export const listVersions = (pipelineId: string, limit = 50) =>
  rows<VersionRow>(
    `SELECT pipeline_id, version, created_by, created_at, eval_summary, notes,
            spec
       FROM versions WHERE pipeline_id = $1 ORDER BY version DESC LIMIT $2`,
    [pipelineId, limit],
  );

export const getVersion = (pipelineId: string, version: number) =>
  one<VersionRow>('SELECT * FROM versions WHERE pipeline_id = $1 AND version = $2', [pipelineId, version]);

export const latestVersion = (pipelineId: string) =>
  one<VersionRow>(
    'SELECT * FROM versions WHERE pipeline_id = $1 ORDER BY version DESC LIMIT 1',
    [pipelineId],
  );

/**
 * Publishes the draft as the next version. The version number is taken inside
 * the transaction, so two concurrent publishes produce two versions rather
 * than one lost update.
 */
export async function publishVersion(
  pipelineId: string,
  spec: PipelineSpec,
  createdBy = 'local',
  notes?: string,
): Promise<VersionRow> {
  return tx(async (client) => {
    // A transaction-scoped advisory lock per pipeline. `FOR UPDATE` cannot
    // serialize this because there may be no rows yet to lock, and an
    // aggregate cannot take a row lock anyway.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pipelineId]);
    const next = await client.query<{ next: number }>(
      'SELECT COALESCE(max(version), 0) + 1 AS next FROM versions WHERE pipeline_id = $1',
      [pipelineId],
    );
    const version = next.rows[0].next;
    const stored: PipelineSpec = { ...spec, version };
    const inserted = await client.query<VersionRow>(
      `INSERT INTO versions (pipeline_id, version, spec, created_by, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [pipelineId, version, JSON.stringify(stored), createdBy, notes ?? null],
    );
    await client.query(
      'UPDATE pipelines SET draft_spec = $2, description = $3, updated_at = now() WHERE id = $1',
      [pipelineId, JSON.stringify(stored), stored.description ?? ''],
    );
    return inserted.rows[0];
  });
}


export const setVersionEvalSummary = (pipelineId: string, version: number, summary: unknown) =>
  query('UPDATE versions SET eval_summary = $3 WHERE pipeline_id = $1 AND version = $2', [
    pipelineId,
    version,
    JSON.stringify(summary),
  ]);

/**
 * The spec a classify request should run: the pinned version if set, else the
 * newest published one.
 */
export async function resolveServingVersion(
  pipelineId: string,
  requested?: number | null,
): Promise<VersionRow> {
  if (requested) {
    const v = await getVersion(pipelineId, requested);
    if (!v) throw problem('version_not_found', `pipeline "${pipelineId}" has no version ${requested}`);
    return v;
  }
  const pipeline = await requirePipeline(pipelineId);
  if (pipeline.pinned_version) {
    const v = await getVersion(pipelineId, pipeline.pinned_version);
    if (v) return v;
  }
  const latest = await latestVersion(pipelineId);
  if (!latest) {
    throw problem(
      'version_not_found',
      `pipeline "${pipelineId}" has no published versions yet; publish the draft first`,
    );
  }
  return latest;
}

export interface WorkingSpec {
  spec: PipelineSpec;
  /** The published version it is, or null for a draft with unpublished changes. */
  version: number | null;
  source: 'draft' | 'version';
}

/**
 * What the builder tries and evaluates: whichever is newer of the draft and
 * the latest published version. Publishing copies the spec into the draft, so
 * a draft that differs from the latest version was edited after it.
 */
export async function resolveWorkingSpec(pipelineId: string): Promise<WorkingSpec> {
  const pipeline = await requirePipeline(pipelineId);
  const latest = await latestVersion(pipelineId);
  const draft = pipeline.draft_spec;
  if (draft && (!latest || !sameSpec(draft, latest.spec))) {
    return { spec: draft, version: null, source: 'draft' };
  }
  if (!latest) throw problem('conflict', `pipeline "${pipelineId}" has no spec yet; compile or write one first`);
  return { spec: latest.spec, version: latest.version, source: 'version' };
}

/** Deep equality that ignores key order and the version stamp a publish adds. */
function sameSpec(a: PipelineSpec, b: PipelineSpec): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  const strip = ({ version: _version, ...rest }: PipelineSpec) => rest;
  return JSON.stringify(canon(strip(a))) === JSON.stringify(canon(strip(b)));
}

// --------------------------------------------------------------- test cases

export interface TestCaseRow {
  id: number;
  pipeline_id: string;
  name: string | null;
  input: Record<string, unknown> | string;
  expected: Record<string, unknown>;
  source: 'compiler' | 'manual' | 'feedback';
  created_at: Date;
}

export const listTestCases = (pipelineId: string) =>
  rows<TestCaseRow>('SELECT * FROM test_cases WHERE pipeline_id = $1 ORDER BY id', [pipelineId]);

export const addTestCase = (
  pipelineId: string,
  test: TestCase,
  source: TestCaseRow['source'] = 'manual',
) =>
  one<TestCaseRow>(
    `INSERT INTO test_cases (pipeline_id, name, input, expected, source)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [pipelineId, test.name ?? null, JSON.stringify(test.input), JSON.stringify(test.expect), source],
  );

export const deleteTestCase = (pipelineId: string, id: number) =>
  query('DELETE FROM test_cases WHERE pipeline_id = $1 AND id = $2', [pipelineId, id]);

/** Replaces the compiler-generated set, leaving manual and feedback cases alone. */
export async function replaceCompilerTests(pipelineId: string, tests: TestCase[]): Promise<void> {
  await tx(async (client) => {
    await client.query("DELETE FROM test_cases WHERE pipeline_id = $1 AND source = 'compiler'", [pipelineId]);
    for (const t of tests) {
      await client.query(
        `INSERT INTO test_cases (pipeline_id, name, input, expected, source)
         VALUES ($1, $2, $3, $4, 'compiler')`,
        [pipelineId, t.name ?? null, JSON.stringify(t.input), JSON.stringify(t.expect)],
      );
    }
  });
}

// -------------------------------------------------------------------- runs

export const hashInput = (input: unknown): string =>
  createHash('sha256').update(typeof input === 'string' ? input : JSON.stringify(input)).digest('hex');

export interface RunRow {
  id: string;
  pipeline_id: string;
  version: number;
  input_hash: string;
  input: unknown;
  output: Record<string, unknown>;
  node_answers: Record<string, unknown>;
  model: string;
  input_tokens: number;
  decision_calls: number;
  cost_usd: number | null;
  latency_ms: number;
  low_confidence: boolean;
  retain_reason: string;
  created_at: Date;
}

export async function insertRun(row: {
  result: RunResult;
  input: unknown | null;
  retainReason: string;
}): Promise<void> {
  const { result } = row;
  const lowConfidence = Object.values(result.nodes).some((n) => n.low_confidence);
  await query(
    `INSERT INTO runs (id, pipeline_id, version, input_hash, input, output, node_answers, model,
                       input_tokens, decision_calls, cost_usd, latency_ms, low_confidence,
                       retain_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT DO NOTHING`,
    [
      result.run_id,
      result.pipeline,
      result.version,
      hashInput(row.input ?? result.output),
      row.input === null ? null : JSON.stringify(row.input),
      JSON.stringify(result.output),
      JSON.stringify(result.nodes),
      result.model,
      result.usage.input_tokens,
      result.usage.decision_calls,
      result.usage.cost_usd ?? null,
      result.latency_ms,
      lowConfidence,
      row.retainReason,
    ],
  );
}

export interface RunQuery {
  pipelineId: string;
  limit?: number;
  before?: string;
  lowConfidenceOnly?: boolean;
  version?: number;
  needsReview?: boolean;
  search?: string;
}

export async function queryRuns(q: RunQuery): Promise<RunRow[]> {
  const where: string[] = ['r.pipeline_id = $1'];
  const params: unknown[] = [q.pipelineId];
  if (q.version) {
    params.push(q.version);
    where.push(`r.version = $${params.length}`);
  }
  if (q.lowConfidenceOnly) where.push('r.low_confidence');
  if (q.before) {
    params.push(q.before);
    where.push(`r.created_at < $${params.length}`);
  }
  if (q.needsReview) where.push('NOT EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = r.id)');
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`r.input::text ILIKE $${params.length}`);
  }
  params.push(Math.min(q.limit ?? 50, 500));
  return rows<RunRow>(
    `SELECT r.* FROM runs r WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT $${params.length}`,
    params,
  );
}

export const getRun = (runId: string) => one<RunRow>('SELECT * FROM runs WHERE id = $1', [runId]);

/** Retention: retained runs older than the window are deleted nightly. */
export async function deleteExpiredRuns(retentionDays: number): Promise<number> {
  const r = await query(`DELETE FROM runs WHERE created_at < now() - ($1 || ' days')::interval`, [retentionDays]);
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------- feedback

export const addFeedback = (input: {
  runId: string;
  pipelineId: string;
  correctOutput?: Record<string, unknown> | null;
  isCorrect?: boolean | null;
  reviewer?: string;
  note?: string;
}) =>
  one<{ id: number }>(
    `INSERT INTO feedback (run_id, pipeline_id, correct_output, is_correct, reviewer, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (run_id) DO UPDATE
       SET correct_output = EXCLUDED.correct_output,
           is_correct = EXCLUDED.is_correct,
           reviewer = EXCLUDED.reviewer,
           note = EXCLUDED.note,
           created_at = now()
     RETURNING id`,
    [
      input.runId,
      input.pipelineId,
      input.correctOutput ? JSON.stringify(input.correctOutput) : null,
      input.isCorrect ?? null,
      input.reviewer ?? 'api',
      input.note ?? null,
    ],
  );

export const listFeedback = (pipelineId: string, limit = 100) =>
  rows(
    `SELECT f.*, r.input, r.output, r.node_answers, r.version
       FROM feedback f LEFT JOIN runs r ON r.id = f.run_id
      WHERE f.pipeline_id = $1
      ORDER BY f.created_at DESC LIMIT $2`,
    [pipelineId, limit],
  );

export const markFeedbackPromoted = (feedbackId: number, testId: number) =>
  query('UPDATE feedback SET promoted_test_id = $2 WHERE id = $1', [feedbackId, testId]);

// -------------------------------------------------------------- eval runs

export const insertEvalRun = (row: Record<string, unknown>) =>
  one<{ id: number }>(
    `INSERT INTO eval_runs (pipeline_id, version, model, resolved_model, accuracy, node_accuracy,
                            confusion, calibration, cases, passed, duration_ms, report, trigger,
                            status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      row.pipeline_id, row.version, row.model, row.resolved_model ?? null, row.accuracy ?? null,
      JSON.stringify(row.node_accuracy ?? {}), JSON.stringify(row.confusion ?? {}),
      JSON.stringify(row.calibration ?? {}), row.cases ?? 0, row.passed ?? 0,
      row.duration_ms ?? null, row.report === undefined ? null : JSON.stringify(row.report), row.trigger ?? 'manual',
      row.status ?? 'done', row.error ?? null,
    ],
  );

/** Summaries only; the full report is fetched one eval at a time. */
export const listEvalRuns = (pipelineId: string, limit = 30) =>
  rows(
    `SELECT id, pipeline_id, version, model, resolved_model, accuracy, node_accuracy, confusion,
            calibration, cases, passed, duration_ms, trigger, status, error, created_at
       FROM eval_runs WHERE pipeline_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [pipelineId, limit],
  );

export const getEvalRun = (pipelineId: string, evalId: number) =>
  one('SELECT * FROM eval_runs WHERE pipeline_id = $1 AND id = $2', [pipelineId, evalId]);

export const lastNightlyEval = (pipelineId: string) =>
  one<{ accuracy: number; resolved_model: string; version: number }>(
    `SELECT accuracy, resolved_model, version FROM eval_runs
      WHERE pipeline_id = $1 AND trigger = 'nightly' AND status = 'done'
      ORDER BY created_at DESC LIMIT 1 OFFSET 1`,
    [pipelineId],
  );

// -------------------------------------------------------------- api keys

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string[];
  pipelines: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

export async function createApiKey(input: {
  name: string;
  scopes?: string[];
  pipelines?: string[] | null;
}): Promise<{ key: string; row: ApiKeyRow }> {
  const secret = randomBytes(24).toString('base64url');
  const key = `ph_live_${secret}`;
  const row = await one<ApiKeyRow>(
    `INSERT INTO api_keys (id, name, prefix, hash, scopes, pipelines)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      `key_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      input.name,
      key.slice(0, 16),
      hashKey(key),
      input.scopes ?? ['classify'],
      input.pipelines ?? null,
    ],
  );
  return { key, row: row! };
}

export const findApiKey = (key: string) =>
  one<ApiKeyRow>('SELECT * FROM api_keys WHERE hash = $1 AND revoked_at IS NULL', [hashKey(key)]);

export const listApiKeys = () =>
  rows<ApiKeyRow>('SELECT id, name, prefix, scopes, pipelines, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC');

/** Returns the revoked key's hash, which is what the auth cache is keyed by. */
export const revokeApiKey = (id: string) =>
  one<{ hash: string }>(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 RETURNING hash',
    [id],
  );

export const touchApiKey = (id: string) =>
  query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]);

// ----------------------------------------------------------- compile runs

export interface CompileRunRow {
  id: string;
  pipeline_id: string;
  job_id: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  mode: 'full' | 'incremental';
  instruction: string | null;
  description: string;
  passes: Record<string, unknown>;
  progress: Record<string, unknown>;
  diff: unknown;
  result_spec: PipelineSpec | null;
  cost_estimate: number | null;
  actual_cost: number | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export const createCompileRun = (input: {
  id: string;
  pipelineId: string;
  description: string;
  mode?: 'full' | 'incremental';
  instruction?: string;
  costEstimate?: number;
}) =>
  one<CompileRunRow>(
    `INSERT INTO compile_runs (id, pipeline_id, description, mode, instruction, cost_estimate)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      input.id,
      input.pipelineId,
      input.description,
      input.mode ?? 'full',
      input.instruction ?? null,
      input.costEstimate ?? null,
    ],
  );

export const getCompileRun = (id: string) =>
  one<CompileRunRow>('SELECT * FROM compile_runs WHERE id = $1', [id]);

export const listCompileRuns = (pipelineId: string, limit = 20) =>
  rows<CompileRunRow>(
    'SELECT * FROM compile_runs WHERE pipeline_id = $1 ORDER BY created_at DESC LIMIT $2',
    [pipelineId, limit],
  );

/** Records one finished pass. This row is what makes a compile resumable. */
export const savePass = (compileId: string, pass: string, output: unknown) =>
  query(
    `UPDATE compile_runs
        SET passes = passes || jsonb_build_object($2::text, $3::jsonb),
            updated_at = now()
      WHERE id = $1`,
    [compileId, pass, JSON.stringify(output)],
  );

export const setCompileStatus = (
  compileId: string,
  status: CompileRunRow['status'],
  fields: Partial<{ error: string; diff: unknown; result_spec: PipelineSpec; actual_cost: number; job_id: string }> = {},
) =>
  query(
    `UPDATE compile_runs
        SET status = $2,
            error = COALESCE($3, error),
            diff = COALESCE($4::jsonb, diff),
            result_spec = COALESCE($5::jsonb, result_spec),
            actual_cost = COALESCE($6, actual_cost),
            job_id = COALESCE($7, job_id),
            updated_at = now(),
            finished_at = CASE WHEN $2 IN ('done','failed','cancelled') THEN now() ELSE finished_at END
      WHERE id = $1`,
    [
      compileId,
      status,
      fields.error ?? null,
      fields.diff === undefined ? null : JSON.stringify(fields.diff),
      fields.result_spec === undefined ? null : JSON.stringify(fields.result_spec),
      fields.actual_cost ?? null,
      fields.job_id ?? null,
    ],
  );

export const setCompileProgress = (compileId: string, progress: Record<string, unknown>) =>
  query('UPDATE compile_runs SET progress = $2, updated_at = now() WHERE id = $1', [
    compileId,
    JSON.stringify(progress),
  ]);

// ----------------------------------------------------------------- budget

/**
 * Reserves budget for a compile. Read and increment happen in one statement,
 * so two compiles starting at once cannot both pass a check that only one
 * should.
 */
export async function reserveCompileBudget(
  estimateUsd: number,
  limitUsd: number,
): Promise<{ ok: boolean; spent: number; limit: number }> {
  return tx(async (client: PoolClient) => {
    const month = new Date();
    month.setUTCDate(1);
    const key = month.toISOString().slice(0, 10);
    await client.query(
      `INSERT INTO compile_budget (month, limit_usd) VALUES ($1, $2)
       ON CONFLICT (month) DO NOTHING`,
      [key, limitUsd],
    );
    const current = await client.query<{ spent_usd: number; limit_usd: number | null }>(
      'SELECT spent_usd, limit_usd FROM compile_budget WHERE month = $1 FOR UPDATE',
      [key],
    );
    const spent = Number(current.rows[0]?.spent_usd ?? 0);
    const limit = Number(current.rows[0]?.limit_usd ?? limitUsd);
    if (limit > 0 && spent + estimateUsd > limit) {
      return { ok: false, spent, limit };
    }
    await client.query('UPDATE compile_budget SET spent_usd = spent_usd + $2 WHERE month = $1', [
      key,
      estimateUsd,
    ]);
    return { ok: true, spent: spent + estimateUsd, limit };
  });
}

/** Trues up the reservation once OpenRouter reports what the compile cost. */
export async function settleCompileBudget(estimateUsd: number, actualUsd: number): Promise<void> {
  const month = new Date();
  month.setUTCDate(1);
  await query(
    'UPDATE compile_budget SET spent_usd = GREATEST(0, spent_usd - $2 + $3) WHERE month = $1',
    [month.toISOString().slice(0, 10), estimateUsd, actualUsd],
  );
}

export const compileBudgetState = () =>
  one<{ month: Date; spent_usd: number; limit_usd: number | null }>(
    'SELECT * FROM compile_budget ORDER BY month DESC LIMIT 1',
  );

// ------------------------------------------------------------ shadow/drift

export const insertShadowResult = (row: {
  pipelineId: string;
  runId: string;
  liveVersion: number;
  draftOutput: unknown;
  liveOutput: unknown;
  agreed: boolean;
}) =>
  query(
    `INSERT INTO shadow_results (pipeline_id, run_id, live_version, draft_output, live_output, agreed)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [row.pipelineId, row.runId, row.liveVersion, JSON.stringify(row.draftOutput), JSON.stringify(row.liveOutput), row.agreed],
  );

export const shadowAgreement = (pipelineId: string, days = 7) =>
  one<{ total: number; agreed: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE agreed)::int AS agreed
       FROM shadow_results
      WHERE pipeline_id = $1 AND created_at > now() - ($2 || ' days')::interval`,
    [pipelineId, days],
  );

export const listWebhooks = (pipelineId: string, event: string) =>
  rows<{ id: number; url: string; secret: string | null }>(
    `SELECT id, url, secret FROM webhooks
      WHERE active AND event = $2 AND (pipeline_id = $1 OR pipeline_id IS NULL)`,
    [pipelineId, event],
  );

export const addWebhook = (input: { pipelineId: string | null; url: string; event: string; secret?: string }) =>
  one<{ id: number }>(
    'INSERT INTO webhooks (pipeline_id, url, event, secret) VALUES ($1,$2,$3,$4) RETURNING id',
    [input.pipelineId, input.url, input.event, input.secret ?? null],
  );

// -------------------------------------------------------------------- meta

export const getMeta = async <T>(key: string): Promise<T | null> => {
  const row = await one<{ value: T }>('SELECT value FROM meta WHERE key = $1', [key]);
  return row?.value ?? null;
};

export const setMeta = (key: string, value: unknown) =>
  query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
