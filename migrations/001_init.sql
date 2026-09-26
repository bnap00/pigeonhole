-- Pigeonhole schema. The app applies this on first boot.

CREATE TABLE pipelines (
  id             TEXT PRIMARY KEY,
  description    TEXT NOT NULL DEFAULT '',
  draft_spec     JSONB,
  pinned_version INTEGER,
  owner          TEXT NOT NULL DEFAULT 'local',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at    TIMESTAMPTZ
);

-- Immutable snapshots. Nothing updates a spec here; publishing inserts.
CREATE TABLE versions (
  pipeline_id   TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  spec          JSONB NOT NULL,
  created_by    TEXT NOT NULL DEFAULT 'local',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  eval_summary  JSONB,
  notes         TEXT,
  PRIMARY KEY (pipeline_id, version)
);

CREATE TABLE test_cases (
  id            BIGSERIAL PRIMARY KEY,
  pipeline_id   TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name          TEXT,
  input         JSONB NOT NULL,
  expected      JSONB NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('compiler', 'manual', 'feedback')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX test_cases_pipeline ON test_cases (pipeline_id);

-- Retained runs, with full payloads, as each pipeline's `compose.logging.retain`
-- decides. Every run's telemetry goes to run_events regardless.
CREATE TABLE runs (
  id             TEXT PRIMARY KEY,
  pipeline_id    TEXT NOT NULL,
  version        INTEGER NOT NULL,
  input_hash     TEXT NOT NULL,
  input          JSONB,
  output         JSONB NOT NULL,
  node_answers   JSONB NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  decision_calls INTEGER NOT NULL DEFAULT 1,
  cost_usd       NUMERIC(12, 8),
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  low_confidence BOOLEAN NOT NULL DEFAULT false,
  retain_reason  TEXT NOT NULL DEFAULT 'all',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runs_pipeline_time ON runs (pipeline_id, created_at DESC);
CREATE INDEX runs_low_conf ON runs (pipeline_id, created_at DESC) WHERE low_confidence;

CREATE TABLE feedback (
  id               BIGSERIAL PRIMARY KEY,
  run_id           TEXT NOT NULL UNIQUE,
  pipeline_id      TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  correct_output   JSONB,
  is_correct       BOOLEAN,
  reviewer         TEXT NOT NULL DEFAULT 'api',
  note             TEXT,
  promoted_test_id BIGINT REFERENCES test_cases(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX feedback_pipeline ON feedback (pipeline_id, created_at DESC);

CREATE TABLE eval_runs (
  id             BIGSERIAL PRIMARY KEY,
  pipeline_id    TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  model          TEXT NOT NULL,           -- the model asked for
  resolved_model TEXT,                    -- what the provider actually served; drift traces to this
  accuracy       REAL,
  node_accuracy  JSONB,
  confusion      JSONB,
  calibration    JSONB,
  cases          INTEGER NOT NULL DEFAULT 0,
  passed         INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  report         JSONB,                   -- the full report
  trigger        TEXT NOT NULL DEFAULT 'manual'
    CHECK (trigger IN ('manual', 'save', 'nightly', 'ci', 'compile')),
  status         TEXT NOT NULL DEFAULT 'done',
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX eval_runs_pipeline ON eval_runs (pipeline_id, created_at DESC);

CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,           -- shown in the UI; the secret never is
  hash          TEXT NOT NULL UNIQUE,    -- sha256 of the full key
  scopes        TEXT[] NOT NULL DEFAULT ARRAY['classify'],
  pipelines     TEXT[],                  -- NULL means every pipeline
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

-- Per-pass compile state. A worker that dies mid-compile is retried and
-- restarts at the first unfinished pass rather than paying for the rest again.
CREATE TABLE compile_runs (
  id            TEXT PRIMARY KEY,
  pipeline_id   TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  job_id        TEXT,
  status        TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  mode          TEXT NOT NULL DEFAULT 'full'
    CHECK (mode IN ('full', 'incremental')),
  instruction   TEXT,                    -- for incremental edits
  description   TEXT NOT NULL DEFAULT '',
  passes        JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress      JSONB NOT NULL DEFAULT '{}'::jsonb,
  diff          JSONB,
  result_spec   JSONB,
  cost_estimate NUMERIC(12, 6),
  actual_cost   NUMERIC(12, 6),
  error         TEXT,
  created_by    TEXT NOT NULL DEFAULT 'local',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX compile_runs_pipeline ON compile_runs (pipeline_id, created_at DESC);

-- Monthly compile spend, reserved in a transaction so concurrent compiles
-- cannot both slip under the limit.
CREATE TABLE compile_budget (
  month         DATE PRIMARY KEY,
  spent_usd     NUMERIC(12, 6) NOT NULL DEFAULT 0,
  limit_usd     NUMERIC(12, 6)
);

-- Draft-vs-live comparisons from shadow mode.
CREATE TABLE shadow_results (
  id            BIGSERIAL PRIMARY KEY,
  pipeline_id   TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL,
  live_version  INTEGER NOT NULL,
  draft_output  JSONB NOT NULL,
  live_output   JSONB NOT NULL,
  agreed        BOOLEAN NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shadow_pipeline ON shadow_results (pipeline_id, created_at DESC);

-- The job queue: compiles, evals, async classifies, webhooks, nightly work.
CREATE TABLE jobs (
  id            BIGSERIAL PRIMARY KEY,
  queue         TEXT NOT NULL,
  payload       JSONB NOT NULL,
  dedupe_key    TEXT,
  state         TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'done', 'failed', 'dead')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at     TIMESTAMPTZ,
  locked_by     TEXT,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX jobs_pending ON jobs (queue, run_at) WHERE state = 'queued';
CREATE UNIQUE INDEX jobs_dedupe ON jobs (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running');

-- Run telemetry: one row per node answer, for the builder's analytics panels.
CREATE TABLE run_events (
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  pipeline       TEXT NOT NULL,
  version        INTEGER NOT NULL,
  run_id         TEXT NOT NULL,
  node           TEXT NOT NULL,
  answer         TEXT,
  confidence     REAL,
  latency_ms     INTEGER,
  input_tokens   INTEGER,
  model          TEXT,
  low_confidence BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX run_events_pipeline_ts ON run_events (pipeline, ts DESC);
CREATE INDEX run_events_node ON run_events (pipeline, node, ts DESC);

CREATE TABLE webhooks (
  id            BIGSERIAL PRIMARY KEY,
  pipeline_id   TEXT REFERENCES pipelines(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  event         TEXT NOT NULL DEFAULT 'drift'
    CHECK (event IN ('drift', 'async_result', 'eval_done')),
  secret        TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Small key/value state: the seeded flag, shadow-mode flags, schedule claims.
CREATE TABLE meta (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
