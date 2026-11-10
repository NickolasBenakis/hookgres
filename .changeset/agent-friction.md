---
"hookgres": minor
---

Remove the glue code apps had to write around Hookgres:

- `hookgres/kysely` exports `fromKysely(trx)` and `hookgres/prisma` exports `fromPrisma(tx)`, which turn a Kysely transaction or a Prisma interactive transaction into the `client` that `send()` takes. They replace the adapters the ORM guides asked you to copy. `kysely` is an optional peer dependency (`fromPrisma` imports nothing from Prisma); Hookgres still has no runtime dependencies.
- `hookgres.drain({ timeoutMs })` calls `runOnce()` until nothing is due or time runs out, and returns how many deliveries it processed. It never starts a batch that might not finish within `timeoutMs` (a batch can take up to `requestTimeoutMs`). Use it from cron routes instead of a hand-written `runOnce()` loop.
- `HookgresValidationError` (extends `Error`) is now thrown for invalid arguments and options, such as an invalid or blocked endpoint URL, bad `eventTypes`, a malformed secret, or invalid `send()` input, so routes can return them as `400` with `instanceof HookgresValidationError`. Messages and the situations that throw are unchanged; database errors are passed through as before.
- Docs: the Hono and Next.js recipes answer a malformed JSON body with `400` instead of `500`, and the Express and Hono shutdown handlers run once when `SIGINT` follows `SIGTERM`.
