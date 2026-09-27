# Architecture

Two containers: **app** and **postgres**, plus **laya** when the `laya`
compose profile is on ([Laya](laya.md)). The app is one Node process that
serves the API, the builder UI and MCP, drains the job queue, and runs the
nightly schedule. Postgres holds all state, including the queue.

## A classify request

```
client ──▶ app ──▶ OpenRouter Decisions API (Jev, POST /api/alpha/decisions)
            │   └─▶ or laya-serve (Laya, POST /v1/systemone), same wire format
            │
            ├─ spec cache (in memory, invalidated over Postgres LISTEN/NOTIFY)
            ├─ answer cache (optional, per pipeline, in memory)
            └─▶ Postgres: run record + run_events telemetry (after the response)
```

The executor groups the spec's model nodes into layers. Nodes in one layer go
to the decision model as **one call**; only a node that consumes another's answer waits for a
second. `rule` nodes and output mappings run locally.

## Compiling

A compile is a queue job of five passes: draft, sharpen, tests, dry run and
repair. Each is a separate structured-output call to an OpenRouter chat model.
Every pass is saved before the next begins, so a compile interrupted by a
restart resumes at the first unfinished pass instead of paying again. Progress
streams to the builder over SSE. The result is a proposed draft and a diff;
nothing goes live until it is published.

## Background work

The `jobs` table is the queue. `FOR UPDATE SKIP LOCKED` hands each job to
exactly one consumer. Failed jobs retry with backoff and are dead-lettered
after five attempts, with an `error` log line. Jobs cover compiles, evals,
async classify, webhook delivery, shadow runs, the nightly drift scan and
retention.

The nightly schedules claim their day in Postgres before they enqueue, so a
restart cannot fire the same night twice.

## State

Everything is in Postgres: pipelines, immutable versions, test cases, evals
(with the full report), API keys (hashed), retained runs, run telemetry, and
the queue. The whole schema is one file, `migrations/001_init.sql`.

## Models

Classifications are answered only by **decision models**, never by a chat
model. `src/provider/models.ts` lists each decision-model family and the
provider that serves it: Jev on OpenRouter's Decisions API, Laya on a local
`laya-serve`. `src/provider/index.ts` sends every `decide()` call to the right
provider for its model. Both speak the same wire format, read and written by
`src/provider/wire.ts`.

To add a model:

- **Served by OpenRouter's Decisions API:** add its family to `models.ts`.
- **Served somewhere else**: add the family with a new provider name, write a
  provider module next to `openrouter.ts` whose `decide()` maps the request
  and response to `DecisionRequest`/`DecisionResponse`, and register it in
  `index.ts`. `laya.ts` is the example.

## Source layout

| Path | |
| --- | --- |
| `src/spec` | The spec format, sandboxed expressions, the linter |
| `src/executor` | Layering and execution |
| `src/provider` | Decision-model registry, provider routing, the OpenRouter and Laya clients |
| `docker/laya` | The image for the optional `laya` service |
| `src/compiler` | The five resumable passes |
| `src/evals` | Accuracy, calibration, drift, webhooks |
| `src/analytics` | Run telemetry and the analytics queries |
| `src/server` | HTTP API, UI, MCP |
| `src/queue`, `src/jobs` | The job queue, job handlers, the nightly schedule |
| `src/cli` | The `pigeonhole` command |
| `migrations/` | The schema, applied on first boot |
