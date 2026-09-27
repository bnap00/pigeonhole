# Troubleshooting

Start with `make logs`. Every failure logs its cause, including rejected
tokens, OpenRouter errors and dead-lettered jobs.

## Setup and access

**The app will not start: `PH_ADMIN_TOKEN is not set`.**
Run `make init`, which generates it, then `make up`.

**The UI keeps asking for the admin token.**
Paste only the value, not the whole line. To print it:
`grep '^PH_ADMIN_TOKEN=' .env | cut -d= -f2-`. If it still bounces, check the
server has the same token: `docker compose exec app printenv PH_ADMIN_TOKEN`.
If that differs from `.env`, the container predates your edit; run `make up`.

**`400 Body cannot be empty when content-type is set to 'application/json'`.**
An API client sent `content-type: application/json` with no body, typically
on a `DELETE`. Omit the header when there is no body.

## Classifying

**Every classify returns 502 `provider_error`.**
OpenRouter's Decisions API (`POST https://openrouter.ai/api/alpha/decisions`)
refused the call. `make logs` shows its status:

- **401/403**: OpenRouter rejected `OPENROUTER_API_KEY`. Fix it in `.env`,
  then `make up`.
- **402**: the OpenRouter account is out of credit.
- **400 `Model … does not exist`**: the runtime model is not one OpenRouter
  serves. Use `jev-latest` or a pinned version such as `typesafe/jev-1.13`.

On a `laya` model, the call went to your Laya server instead; see
[Laya troubleshooting](laya.md#troubleshooting).

**A spec is rejected: `uses on_low_confidence: fallback_model`.**
That action re-asked a chat model and has been removed. Use `human_review`,
`error` or `default:<option>`.

**`input_invalid: input does not match the pipeline input schema`.**
The request is missing a field the spec's `input` marks `required`, or has the
wrong type. The error lists each failing path.

## Compiling and evals

**A compile stays on "queued".**
Compiles run on the app's job queue. Check `make logs` for the job; one that
failed five times logs `job dead-lettered`. The builder falls back to polling if its
live progress stream drops, so the page updates either way.

**An eval scores nothing, and "N of N cases could not run".**
No case reached the model. Either OpenRouter could not answer (see above), or
the inputs fail the pipeline's own input schema, usually because the tests
were generated against an older schema. The eval panel lists the errors. See
[evals](evals.md#cases-that-cannot-run).

## Containers

**`make up` fails waiting for `app` to become healthy.**
`make logs`. The last `error` line is the reason; a bad `DATABASE_URL` or a
failed migration is the usual one.
