# Hookgres for AI coding agents

Hookgres sends signed webhooks to your customers from the Postgres you already run. `send()` can join your database transaction, so a webhook is queued only if your data commits. Requires Node.js 22.12+ and Postgres 14+.

This file is for agents adding Hookgres to an app (it ships in the npm package, next to `llms.txt`). Working on Hookgres itself? See https://github.com/NickolasBenakis/hookgres/blob/main/CONTRIBUTING.md.

<!-- The section below is the single source for the instructions in hookgres.dev/llms.txt and the package's llms.txt (scripts/agent-docs.mjs). -->

## Instructions for AI agents

To add Hookgres webhooks to an existing app:

1. Install `hookgres` and `pg` (`npm install hookgres pg`). Create one instance from the app's existing pool: `const hookgres = new Hookgres({ pool })`, with `import { Hookgres } from "hookgres"`.
2. Call `await hookgres.migrate()` on startup. It is idempotent and takes an advisory lock. If the app's database role can't `CREATE`, run it from a deploy step instead.
3. Start the worker in a long-running process with `hookgres.start()`. On `SIGTERM`, `await hookgres.stop()` before `pool.end()` so in-flight requests finish. On serverless, call `await hookgres.drain({ timeoutMs })` from a cron route, with `timeoutMs` a few seconds under the function's time limit, and never `start()`. See https://hookgres.dev/docs/guides/workers.md. Framework recipes: https://hookgres.dev/docs/frameworks/nextjs.md, https://hookgres.dev/docs/frameworks/express.md, https://hookgres.dev/docs/frameworks/hono.md and https://hookgres.dev/docs/frameworks/nestjs.md.
4. Call `hookgres.send({ tenantId, eventType, payload }, { client })` inside the database transaction that makes the change, passing that transaction's client, so the webhook is queued only if it commits. Add `idempotencyKey` when a send can repeat. See https://hookgres.dev/docs/guides/sending.md. With Prisma or Kysely, pass `{ client: fromPrisma(tx) }` (`import { fromPrisma } from "hookgres/prisma"`) or `{ client: fromKysely(trx) }` (`"hookgres/kysely"`). See https://hookgres.dev/docs/guides/drizzle.md, https://hookgres.dev/docs/guides/prisma.md or https://hookgres.dev/docs/guides/kysely.md.
5. Add endpoint management routes scoped to the signed-in tenant: `createEndpoint({ tenantId, url, eventTypes })` (return `endpoint.secret` once), `listEndpoints(tenantId)`, `updateEndpoint(id, patch)`, `deleteEndpoint(id)` and `rotateEndpointSecret(id)`. Take `tenantId` from the session, never the request body, and before updating, deleting or rotating by id, load it with `getEndpoint(id)` and check that `endpoint.tenantId` matches. Return a `HookgresValidationError` (invalid or blocked URL, bad `eventTypes`) as `400` with its message, and rethrow anything else. See https://hookgres.dev/docs/guides/endpoints.md.
6. Pass `blockPrivateAddresses: true` to `new Hookgres({ pool, blockPrivateAddresses: true })`, so customer endpoint URLs can't reach private or internal addresses. Hookgres checks them when an endpoint is created and again after DNS on every delivery. See https://hookgres.dev/docs/guides/production.md.
7. Pass `onError` to the app's logger. Receivers verify with `verifyWebhook({ secret, headers, body })` on the raw body and deduplicate on `webhook-id`. See https://hookgres.dev/docs/guides/verifying.md and https://hookgres.dev/docs/reference/api.md.

## Common mistakes

- `send()` without `{ client }` runs on the pool, outside your transaction: the webhook is queued even if the transaction rolls back.
- An error like `relation "hookgres.endpoints" does not exist` means `migrate()` hasn't run against this database and schema.
- `start()` in a serverless function: the loop freezes between requests. Use `drain({ timeoutMs })` from a cron route.
- `verifyWebhook` with a parsed JSON body: the signature won't match. Pass the raw body (`express.raw()`, `await request.text()`).
- `send()` to a tenant with no endpoints is not an error: it returns `deliveryCount: 0`.

## Reference

Every export has JSDoc in `dist/*.d.ts`, and every function, method and options type has an example. Error messages say how to fix the problem and link the relevant page. Full docs: https://hookgres.dev/llms-full.txt, or `llms.txt` in this package for an index.
