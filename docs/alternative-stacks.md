# Alternative stacks

Pigeonhole ships as two containers: a Node app and Postgres. That is the only
supported way to run it. This page sketches other stacks it could run on.
**None of them is built.** They are here as ideas, and as a starting point for
anyone who wants to build one.

## Cloudflare Workers

A classify endpoint is a small, bursty, I/O-bound HTTP service whose real work
happens at the model provider. That suits Workers:

- **No idle cost.** A pipeline nobody calls costs nothing, where the container
  stack runs around the clock.
- **No cold path.** Isolates start in milliseconds.
- **Deploy is `wrangler deploy`.** No VM, no container, no database server.

### How the pieces would map

| Here | On Cloudflare | Why |
| --- | --- | --- |
| Fastify app | One Worker (fetch handler), UI as static assets | Same origin for API and UI, one deploy |
| Postgres | D1 | Pipelines, versions, tests and keys want SQL and transactions |
| In-memory spec cache | KV | Specs change rarely and are read on every request |
| `jobs` table queue | Queues | Retries and a dead-letter queue for async classify and webhooks |
| Compile and eval jobs | Workflows | A compile takes minutes; each pass becomes a retried step |
| Nightly schedule | Cron Triggers, which start a Workflow | The cron only starts the work |
| `run_events` telemetry | Analytics Engine | Writing a D1 row per run gets expensive at volume |
| Retained runs | D1, sampled | Only the runs a person will look at |

### What would carry over, and what would not

- **Carries over:** the spec format, the expression language
  (`src/spec/expr.ts` has no dependencies), the decision-model registry
  (`src/provider/models.ts`) and the executor's logic. The REST API and spec
  files would be identical, so a pipeline could move between stacks with
  `pigeonhole pull` / `push`.
- **Needs rework:** `src/config.ts` reads `package.json` from disk and would
  come from Worker bindings instead. Ajv compiles validators with
  `new Function`, which Workers forbid, so input schemas would need
  precompiled or interpreted validation.
- **Platform limits that shape it:** a Worker invocation allows 50
  subrequests on the free plan and 1,000 on paid. Every batch input is one
  model call, so batch size would need a cap. Six simultaneous outbound
  connections means batches fan out through a concurrency limiter. KV is
  eventually consistent (around 60 seconds), so publishing needs to write D1
  first and treat KV as a cache.

If you want to build this, open an issue first so we can agree on the shape.
