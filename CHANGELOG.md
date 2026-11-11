# Changelog

## 0.5.1

### Patch Changes

- [#43](https://github.com/NickolasBenakis/hookgres/pull/43) [`25ad71e`](https://github.com/NickolasBenakis/hookgres/commit/25ad71eb5edd09313d0522fef92435236ad68bb2) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - `send()` works on a `client` whose driver returns timestamps as strings, such as a Drizzle transaction: `message.createdAt` and `message.redactedAt` are now always `Date` objects. Before, they came back as strings on those clients.

  The package's `AGENTS.md` also points coding agents to [Using your ORM's transaction](https://hookgres.dev/docs/guides/orms), which has tested wrappers of a few lines for Drizzle, postgres.js, Knex, Sequelize and TypeORM, so `send()` joins those transactions too.

## 0.5.0

### Minor Changes

- [#31](https://github.com/NickolasBenakis/hookgres/pull/31) [`455ea55`](https://github.com/NickolasBenakis/hookgres/commit/455ea55f7ef4fed94951f5b18b89ec5b54e1bf4e) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Add privacy controls for GDPR. **Run `migrate()` before this version serves traffic:** the worker now reads the new `messages.redacted_at` column, and without the migration it fails with a `column ... does not exist` error that says to run `migrate()`. Turn on `redactPayloads` only once every instance runs this version.
  - `redactPayloads` (default `false`) clears a message's payload once every delivery of it has succeeded, or right away when no endpoint matched, and keeps the delivery log. `Message` gets `redactedAt`, and `payload` is `null` once redacted. Payloads of failed deliveries are kept for replay; replaying a redacted delivery throws a `HookgresValidationError`. `migrate()` makes `messages.payload` nullable and adds `messages.redacted_at` (catalog-only changes, no table rewrite).
  - `responseBodyLimit` (default and maximum 4096) sets how many characters of each receiver response the attempt log stores; `0` stores none.
  - `deleteMessages({ tenantId, messageIds, payloadContains })` deletes matching messages with their deliveries and attempts, whatever their status, for erasure requests and offboarding. At least one filter is required, and `payloadContains` must be plain, non-empty JSON with no `undefined`, functions or `NaN` (any of these could match every payload).
  - New docs page: Privacy and GDPR.

## 0.4.0

### Minor Changes

- [#29](https://github.com/NickolasBenakis/hookgres/pull/29) [`21f725e`](https://github.com/NickolasBenakis/hookgres/commit/21f725edae233399ac187e6b86d1a588cd9792a7) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Remove the glue code apps had to write around Hookgres:
  - `hookgres/kysely` exports `fromKysely(trx)` and `hookgres/prisma` exports `fromPrisma(tx)`, which turn a Kysely transaction or a Prisma interactive transaction into the `client` that `send()` takes. They replace the adapters the ORM guides asked you to copy. `kysely` is an optional peer dependency (`fromPrisma` imports nothing from Prisma); Hookgres still has no runtime dependencies.
  - `hookgres.drain({ timeoutMs })` calls `runOnce()` until nothing is due or time runs out, and returns how many deliveries it processed. It never starts a batch that might not finish within `timeoutMs` (a batch can take up to `requestTimeoutMs`). Use it from cron routes instead of a hand-written `runOnce()` loop.
  - `HookgresValidationError` (extends `Error`) is now thrown for invalid arguments and options, such as an invalid or blocked endpoint URL, bad `eventTypes`, a malformed secret, or invalid `send()` input, so routes can return them as `400` with `instanceof HookgresValidationError`. Messages and the situations that throw are unchanged; database errors are passed through as before.
  - Docs: the Hono and Next.js recipes answer a malformed JSON body with `400` instead of `500`, and the Express and Hono shutdown handlers run once when `SIGINT` follows `SIGTERM`.

### Patch Changes

- [#27](https://github.com/NickolasBenakis/hookgres/pull/27) [`88c1049`](https://github.com/NickolasBenakis/hookgres/commit/88c1049990a742983fc93356f98e6213fc723556) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Make the package easier for AI coding agents (and people) to use correctly:
  - Every public export has JSDoc, and every function, `Hookgres` method and options type has caveats and an `@example`, kept in the published `.d.ts` files.
  - The package now ships `AGENTS.md` (integration steps for coding agents) and `llms.txt`.
  - Error messages say how to fix the problem and link the relevant docs page. Calling Hookgres before `migrate()` now adds "call `await hookgres.migrate()`" to Postgres's `relation ... does not exist` error (same error object and `code`). Error classes and codes are unchanged.

## 0.3.0

### Minor Changes

- [#19](https://github.com/NickolasBenakis/hookgres/pull/19) [`22c2dee`](https://github.com/NickolasBenakis/hookgres/commit/22c2deea83c36067f34ed87fb1c40adb2fdd48bf) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Add the `notify` option (default `false`). With it on, `send()` and `replayDelivery()` run `pg_notify` in the same statement, and each worker started with `start()` holds one pool connection that runs `LISTEN`, so workers in every process wake as soon as a webhook is committed instead of waiting for `pollIntervalMs`. Polling stays as the fallback, and a dropped listener reconnects with backoff. Leave it off behind PgBouncer in transaction mode. Add the `onAttempt` and `onEndpointDisabled` hooks, called after every HTTP attempt and when an endpoint is disabled automatically; errors they throw are reported with `process.emitWarning` and never affect delivery. The `AttemptEvent`, `AttemptOutcome` and `EndpointDisabledEvent` types are exported. `migrate()` now adds an index on `messages (created_at)` so `cleanup()` stays fast on large tables. A pool Hookgres creates from `connectionString` now reports idle-connection errors to `onError` instead of crashing the process.

- [#15](https://github.com/NickolasBenakis/hookgres/pull/15) [`7150a2b`](https://github.com/NickolasBenakis/hookgres/commit/7150a2b0ca0bd1fe5a0fe14e5a000a07bdbde720) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Add `cleanup({ olderThan, batchSize })`, which deletes old messages whose deliveries are all finished, in batches, and returns how many it deleted. Add the `retryJitter` option (default 0.1), which spreads each retry wait randomly by up to that fraction so failed deliveries don't all retry at once; set it to 0 for exact waits. Endpoint `eventTypes` now accept wildcards like `invoice.*`, which match every event type under `invoice.` at any depth. A bare `*` is rejected (use `null` for every event), and event types passed to `send()` can't contain `*`. An endpoint saved before 0.3 with a literal entry like `invoice.*` now matches as a wildcard.

## 0.2.0

### Minor Changes

- [#13](https://github.com/NickolasBenakis/hookgres/pull/13) [`ef45cc9`](https://github.com/NickolasBenakis/hookgres/commit/ef45cc90ce9f81991007acad3d176355e3f275fa) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Add the opt-in `blockPrivateAddresses` option, which refuses to send webhooks to private and internal addresses (checked at endpoint creation and on every delivery, after DNS), and export `isPrivateAddress`.

## 0.1.1

### Patch Changes

- [#7](https://github.com/NickolasBenakis/hookgres/pull/7) [`e302f4f`](https://github.com/NickolasBenakis/hookgres/commit/e302f4faa4fc04675e0971c3dbab16efc8de174d) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - New README with install for npm, pnpm, yarn and bun, a quick start, and links to the docs and llms.txt. No code changes.

- [#8](https://github.com/NickolasBenakis/hookgres/pull/8) [`b29bcfb`](https://github.com/NickolasBenakis/hookgres/commit/b29bcfbe5020ece76efae3c55f3ed7f32f54047c) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Package metadata no longer lists a personal email; report security issues through GitHub's private vulnerability reporting.

## 0.1.0

First release.

- Endpoints per tenant with event-type filters, generated or custom
  Standard Webhooks secrets, and secret rotation with a grace period.
- `send()` queues a message and its deliveries in one atomic statement, with
  idempotency keys and optional participation in the caller's transaction.
- Delivery worker using `FOR UPDATE SKIP LOCKED`: retries on a schedule,
  per-claim lock tokens, crash recovery, and automatic endpoint disabling.
- Standard Webhooks signing and `verifyWebhook` for receivers.
- Delivery log (messages, deliveries, attempts) and `replayDelivery`.
