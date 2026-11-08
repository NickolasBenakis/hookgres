# Contributing to Hookgres

Thanks for helping. Bug reports, docs fixes and pull requests are all welcome.

## Reporting bugs

Open an [issue](https://github.com/NickolasBenakis/hookgres/issues/new/choose)
with your Hookgres, Node.js and Postgres versions, what you expected, and what
happened. A small script that reproduces it helps most.

Security issues: please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 22.18+, pnpm and Docker.

```sh
pnpm install
docker compose up -d postgres   # or set DATABASE_URL to your own Postgres
pnpm test                       # starts Postgres with testcontainers if DATABASE_URL is unset
```

Before opening a pull request, run:

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm examples      # runs every example against the compose database
pnpm site:build    # if you changed the docs or the landing page
```

`pnpm format` fixes formatting. CI runs the tests on Postgres 14–18 and
Node.js 22, 24 and 26.

## Pull requests

- Keep each pull request to one change, and add a test for any behaviour
  change or bug fix.
- Update the docs in `docs/` when you change behaviour or the API.
- Schema changes go in a new entry at the end of `src/migrations.ts`. Never
  edit a migration that has shipped.
- Add a line to `CHANGELOG.md` for user-facing changes.

## Project layout

| Path        | What's there                                           |
| ----------- | ------------------------------------------------------ |
| `src/`      | The library.                                           |
| `test/`     | Vitest suite, run against a real Postgres.             |
| `examples/` | Runnable examples and the `docker compose` playground. |
| `docs/`     | The VitePress docs served at hookgres.dev/docs.        |
| `site/`     | The landing page at hookgres.dev.                      |
| `scripts/`  | Smoke test, load test, example checks and site build.  |

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
