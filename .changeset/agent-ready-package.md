---
"hookgres": patch
---

Make the package easier for AI coding agents (and people) to use correctly:

- Every public export has JSDoc, and every function, `Hookgres` method and options type has caveats and an `@example`, kept in the published `.d.ts` files.
- The package now ships `AGENTS.md` (integration steps for coding agents) and `llms.txt`.
- Error messages say how to fix the problem and link the relevant docs page. Calling Hookgres before `migrate()` now adds "call `await hookgres.migrate()`" to Postgres's `relation ... does not exist` error (same error object and `code`). Error classes and codes are unchanged.
