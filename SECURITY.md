# Security policy

## Reporting a vulnerability

**Please do not report security issues in public issues, discussions or pull
requests.**

Report privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) (the
**Security** tab → **Report a vulnerability**). Include what you found, how to
reproduce it, and the version or commit.

You can expect an acknowledgement within three working days and a first
assessment within a week. We will keep you informed, credit you in the
advisory unless you prefer otherwise, and ask that you give us a reasonable
window to ship a fix before disclosing.

## Supported versions

Security fixes land on the latest release. Upgrade with `make backup && git pull &&
make up`.

## Scope

In scope: this repository — the application, its container image, the
Compose configuration and the scripts.

Out of scope: vulnerabilities in upstream images (Node, Postgres) unless our
configuration of them introduces the issue; please report those upstream.

## Running it safely

- **No default credentials.** `make up` generates the admin token and the
  database password and writes `.env` at mode 600. API keys are hashed at
  rest, scoped (`classify`, `admin`) and can be limited to named pipelines.
- **Put TLS in front before exposing it.** The app speaks plain HTTP and binds
  to loopback by default (`PH_BIND`). Postgres publishes no port.
- **Treat backups and `.env` like the database.** Backups hold every pipeline,
  stored inputs and the API key hashes.
- **Async webhooks go where the caller says.** A key with the `classify` scope
  can pass a `webhook` URL to `/v1/classify/:pipeline/async`, and the app will
  POST the result there. Only give keys to callers you trust with that.
