# API and clients

Four ways in, all over the same pipelines: REST, the CLI, MCP for agents, and
generated typed clients.

## Authentication

Every request except health takes a bearer token:

```
Authorization: Bearer <token>
```

The admin token (`PH_ADMIN_TOKEN`) can do everything. For applications, create
scoped API keys — `classify` for traffic, `admin` for the control plane —
optionally limited to named pipelines:

```bash
curl -s -X POST http://localhost:8080/v1/keys \
  -H "authorization: Bearer $PH_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"checkout-service","scopes":["classify"]}'
```

The key is shown once and stored hashed. Revoking one (`DELETE /v1/keys/:id`)
takes effect immediately.

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem JSON with
a stable `code`.

## Classify

```bash
curl -s -X POST http://localhost:8080/v1/classify/support-triage \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"input":{"body":"Shoes came in the wrong size"}}'
```

| Endpoint | |
| --- | --- |
| `POST /v1/classify/:pipeline` | One input, synchronous. |
| `POST /v1/classify/:pipeline/batch` | Many inputs in one request. |
| `POST /v1/classify/:pipeline/async` | Queued; the result arrives by webhook or at `/v1/runs/:runId`. |
| `GET /v1/runs/:runId` | A stored run. |
| `POST /v1/runs/:runId/feedback` | The correct answer, which feeds the review queue and future tests. |
| `POST /v1/runs/:runId/replay` | Re-run a stored input against the current version. |

Responses carry `run_id`, `output`, per-node answers with probabilities,
`model` (the resolved version), `usage` and `latency_ms`.

## Control plane

| Area | Endpoints |
| --- | --- |
| Pipelines | `GET/POST /v1/pipelines` · `GET/PUT/DELETE /v1/pipelines/:id` |
| Versions | `POST /v1/pipelines/:id/versions` (publish) · `GET /v1/pipelines/:id/versions/:version` · `POST /v1/pipelines/:id/pin` |
| Compile | `POST /v1/pipelines/:id/compile` · `GET …/compile/:compileId` · `GET …/compile/:compileId/events` (SSE) · `POST …/compile/:compileId/accept` · `GET /v1/pipelines/:id/compiles` |
| Tests | `POST /v1/pipelines/:id/tests` · `DELETE /v1/pipelines/:id/tests/:testId` |
| Evals | `POST /v1/pipelines/:id/evals` (`?wait=true` for ≤ 50 cases) · `GET …/evals` · `GET …/evals/:evalId` · `POST /v1/pipelines/:id/compare` |
| Review | `GET /v1/pipelines/:id/review` · `POST …/review/:runId/promote` · `GET /v1/pipelines/:id/feedback` |
| Shadow | `GET/POST /v1/pipelines/:id/shadow` — run a draft beside the live version |
| Analytics | `GET /v1/pipelines/:id/analytics` · `GET …/analytics/:node/confidence` · `GET /v1/pipelines/:id/runs` |
| Keys | `GET/POST /v1/keys` · `DELETE /v1/keys/:id` |
| Webhooks | `POST /v1/webhooks` |
| Other | `GET /v1/templates` · `GET /v1/status` |
| Unauthenticated | `GET /healthz` · `GET /readyz` |

The compile event stream authenticates with a short-lived ticket in its URL,
because browsers' `EventSource` cannot send an `Authorization` header. The
ticket is returned by `POST …/compile` and is valid for that one compile only.

## Generated clients

```
GET /v1/pipelines/:id/openapi.json
```

A typed OpenAPI 3.1 document where each output is a real union
(`"returns" | "shipping" | "billing" | "other"`), so a generated client is
checked by your compiler.

## CLI

```bash
pigeonhole init "route support tickets to returns, shipping or billing"
pigeonhole edit support-triage "split billing into refunds and invoices"
pigeonhole lint                      # validate local specs
pigeonhole test                      # non-zero exit on regression — a CI gate
pigeonhole classify support-triage "my shoes arrived torn"
pigeonhole diff support-triage --models typesafe/jev-1.13,jev-latest
pigeonhole push / pull               # spec files in git
```

Point it at the app with `--server http://your-host:8080` and `PIGEONHOLE_TOKEN`.

## MCP

Every published pipeline becomes an agent tool at `/mcp` (Streamable HTTP), or
over stdio with `pigeonhole mcp`. Agents get a cheap, calibrated decision
instead of spending reasoning tokens on it.
