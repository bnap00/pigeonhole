# Contributing

Thanks for helping. Bug reports, docs fixes and pull requests are all welcome.

## Before you start

- **Bugs**: open an issue with what you did, what happened, and the relevant
  `make logs` lines.
- **Features**: open an issue first for anything beyond a small change, so we
  can agree on the approach before you spend time on it.
- **Security issues**: never in public — see [SECURITY.md](SECURITY.md).

## Development

You need Node 22+ and Docker.

```bash
npm install
make test          # typecheck, unit + integration tests, with a throwaway Postgres
```

The tests never call OpenRouter: they swap in an offline fake provider
(`test/fake-provider.ts`), so they need no API key.

To run the app with hot reload:

```bash
make test-db       # a Postgres on localhost:55432
DATABASE_URL=postgres://pigeonhole:devpass@localhost:55432/pigeonhole \
PH_ADMIN_TOKEN=dev OPENROUTER_API_KEY=sk-or-... npm run dev
```

**Schema changes.** The schema is one file, `migrations/001_init.sql`. Before
the first tagged release, edit it in place and `make reset`. After a release,
add `002_<name>.sql`: the app applies new files in order on boot.

**Adding a model.** See [architecture](docs/architecture.md#models).

## Pull requests

- Keep each one focused on a single change.
- Add or update tests. A bug fix should come with a test that fails without it.
- Update the docs in the same PR when behaviour, configuration or commands
  change. A new environment variable belongs in `.env.sample` and the
  README's configuration table.
- `make test` must pass: the typecheck and every test.
- Explain *why* in the description, not only *what*.

## Conventions

- TypeScript, ESM, Node 22+. Match the style of the code around you.
- Comments explain *why*: the constraint, the failure mode, the trade-off.
  The code already says what.
- Errors are RFC 9457 problem JSON with a stable `code`.
- Shell scripts run under `set -euo pipefail`, pass `shellcheck`, and never pipe
  a stream into a reader that exits early (`grep -q`, `head`): under
  `pipefail` that turns success into failure.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
