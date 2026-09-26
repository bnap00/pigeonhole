# Pigeonhole

**Describe a classifier in English. Get a typed, tested, versioned API.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

> **Weekend project.** An experiment in building a classification pipeline on
> [Jev](https://openrouter.ai/docs/guides/community/jev), a decision model.
> [Laya](https://www.layaaimodel.com/) may be next, in the same setup. It
> works end to end and is fun to try, but it is not production software. See
> [Status](#status).

You need Docker and an [OpenRouter key](https://openrouter.ai/keys).

```bash
git clone https://github.com/bnap00/pigeonhole && cd pigeonhole
make up        # asks for your OpenRouter key once, then builds and starts
```

Open http://localhost:8080 and paste the admin token `make up` printed. A
demo pipeline is already published, so you can classify something straight
away.

Two containers: the app, and Postgres. One model provider: OpenRouter.

---

## What it does

Classification is the boring half of most LLM features, and the half you pay
for on every request. Pigeonhole splits it in two:

| | When | What happens |
| --- | --- | --- |
| **Compile** | Rarely | A reasoning model on OpenRouter turns your description into a precise spec: questions, options, their definitions, disambiguation rules, and test cases. |
| **Run** | Every request | A decision model (Jev, through OpenRouter's Decisions API) evaluates input against that spec and returns a typed answer with a calibrated probability for every option. |

You write:

> Route support tickets for an online shoe store to returns, shipping or
> billing. Flag angry customers. If it is unclear, send it to a human.

You get an endpoint:

```bash
export PH_ADMIN_TOKEN=…   # printed by `make up`; create scoped keys for apps (docs/api.md)
curl -s -X POST http://localhost:8080/v1/classify/support-triage \
  -H "Authorization: Bearer $PH_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"input": {"body": "Shoes came in the wrong size, can I swap for a 10?"}}'
```

```json
{
  "output": { "team": "returns", "reason": "wrong_size", "priority": "normal", "angry": 0.06, "needs_review": false },
  "nodes": {
    "department": { "choice": "returns", "confidence": 1, "probabilities": { "returns": 1, "shipping": 0, "billing": 0, "other": 0 } },
    "angry": { "p": 0.06, "confidence": 0.88 },
    "urgency": { "score": 1, "confidence": 0.74 }
  },
  "model": "typesafe/jev-1.13-20260917",
  "usage": { "input_tokens": 878, "cost_usd": 0.000037, "decision_calls": 1 },
  "latency_ms": 717
}
```

Independent questions are batched, so that is four decisions for **one model
call**, at a few thousandths of a cent.

## Why not just call a model

- **Versioned and reviewable.** Specs are YAML. Every change is a diff you
  approve before anything goes live, and every version can be pinned.
- **Tested.** Every pipeline carries test cases. `pigeonhole test` is a CI gate.
- **Watched.** Hosted models move under you. Nightly evals report accuracy, a
  confusion matrix and a calibration curve, and alert when accuracy drops.
- **Typed.** Each pipeline publishes an OpenAPI document whose outputs are real
  unions, so generated clients are checked by your compiler.

## Status

This is a weekend project: an experiment in building a Jev pipeline, not a
product.

**Works today:** compiling a description into a spec, classifying through
OpenRouter's Decisions API, batch and async classify, test cases and evals,
drift alerts, versions and pinning, the builder UI, the CLI and MCP.

**Not there yet:**

- One model provider (OpenRouter) and one decision model family (Jev). The
  model layer is built to take others; Laya may be next.
- Single instance only. Rate limits and caches live in memory.
- No automatic backups, no TLS, no multi-user accounts: one admin token.
- The API and spec format may change between versions without a migration
  path until 1.0.

Feedback on the idea is as welcome as code. Open an issue.

## Operating it

| Command | |
| --- | --- |
| `make up` / `make down` | Start (writing `.env` on first run, rebuilding the app) / stop. Data is kept. |
| `make check` | Database, migrations and a real test classification. Non-zero if anything is wrong. |
| `make logs` · `make ps` | Follow logs · container status. |
| `make backup` · `make restore FILE=…` | Dump the database to `backups/` · replace it with a dump, in one transaction. |
| `make psql` | A SQL shell. |
| `make reset` | Delete the database and start fresh. |
| `make test` | Typecheck and every test, against a throwaway Postgres. |

Upgrading is `make backup && git pull && make up`; the app applies any schema
change on boot.

Nothing backs up automatically. If the data matters, schedule `make backup`
and copy `backups/` off the machine, along with `.env`:

```bash
0 4 * * * cd /srv/pigeonhole && make -s backup && rsync -a backups/ backup-host:pigeonhole/
```

## Configuration

Everything lives in `.env`; [.env.sample](.env.sample) documents every
variable. Only three matter:

| Variable | |
| --- | --- |
| `OPENROUTER_API_KEY` | Pays for the decision model and for the compiler's reasoning model. |
| `PH_ADMIN_TOKEN` | Bearer token for the UI, CLI and control plane. Required. |
| `POSTGRES_PASSWORD` | For the bundled database, which publishes no port. |

The app listens on `127.0.0.1:8080` (`PH_BIND`) over plain HTTP. Put a TLS
reverse proxy in front before exposing it beyond the machine.

## Documentation

| | |
| --- | --- |
| [Writing a pipeline](docs/pipelines.md) | The spec format, node types, expressions |
| [Evals and drift](docs/evals.md) | Tests, accuracy, calibration, drift alerts |
| [API and clients](docs/api.md) | REST, CLI, MCP, generated clients |
| [Architecture](docs/architecture.md) | How it works, and how to add a model |
| [Alternative stacks](docs/alternative-stacks.md) | Ideas for running it elsewhere, such as Cloudflare Workers (not built) |
| [Troubleshooting](docs/troubleshooting.md) | The problems you are likely to hit first |

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Report security issues privately: [SECURITY.md](SECURITY.md).

## License

[Apache 2.0](LICENSE)
