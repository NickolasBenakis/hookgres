# Changelog

## 0.6.0

### Minor Changes

- [#56](https://github.com/NickolasBenakis/hookgres/pull/56) [`5f714ce`](https://github.com/NickolasBenakis/hookgres/commit/5f714ce08f8d1dab0dec035c7dbe9471fd880ce3) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Add metrics:
  - `stats({ tenantId?, endpointId? })` returns the queue right now: `pending`, `due`, `delivering`, `oldestDueAt` and `lagMs`, how long the oldest due delivery has waited. It reads the existing partial indexes: about 20ms with 450,000 pending and in-flight deliveries.
  - The `opentelemetry` option takes your `@opentelemetry/api` module (1.7+) and exports `hookgres.delivery.attempts`, `hookgres.delivery.attempt.duration`, `hookgres.endpoints.disabled`, `hookgres.worker.errors`, and the `hookgres.queue.pending`, `.due`, `.delivering` and `.lag` gauges. Attributes are low-cardinality (outcome, status code, `error.type`), with no tenant or endpoint. Hookgres doesn't depend on OpenTelemetry; without the option nothing changes. See the new Metrics and traces guide.

- [#54](https://github.com/NickolasBenakis/hookgres/pull/54) [`5c39e25`](https://github.com/NickolasBenakis/hookgres/commit/5c39e25896c59788fe1a124f95cbc0d19c65c924) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Fix problems found by testing Hookgres at scale and with real integrations:
  - A slow or hanging endpoint no longer holds up every other tenant. Workers now refill slots as deliveries finish instead of waiting for a whole batch. A new `maxInFlightPerEndpoint` option (default: half of `concurrency`) limits how many slots one endpoint can take. In a test, one tenant's 100 queued deliveries to a hung endpoint delayed another tenant's webhook by 10s; now it's delivered in about 50ms.
  - Claiming due deliveries no longer slows down with the size of the backlog. Each claim read and sorted every due row, which took 235–324ms per batch at 1M due. It now uses the indexes in order: about 10ms.
  - A delivery whose keep-alive connection the receiver closed just as it was reused is retried once on a fresh connection, instead of counting as a failed attempt.
  - `send()` rejects a payload containing a `Map`, a `Set` (JSON turns both into `{}`) or a `BigInt` with a `HookgresValidationError`. `WebhookEvent` now types each event's `data` as it arrives after JSON, using the new `Jsonified` type: a `Date` schema output is a `string` on the receiver.
  - `send({ client })` returns a correct result when the client maps columns to camelCase (for example Knex with `knexSnakeCaseMappers`).
  - Docs: the Express receiver recipe registers the webhook route before `express.json()`, which otherwise parses the body first so every signature check fails. The Fastify recipe scopes its raw-body parser to the webhook route.
  - `cleanup({ olderThan: ms })` deleted nothing, and webhook envelopes carried a 1970 `timestamp`, when the database used a non-ISO `DateStyle`. Both now use epoch milliseconds internally. The production guide now covers clocks (NTP), `DateStyle`, pool size with several `notify` instances, and rolling upgrades.

- [#57](https://github.com/NickolasBenakis/hookgres/pull/57) [`d1ef2a0`](https://github.com/NickolasBenakis/hookgres/commit/d1ef2a0a2408ce803b30f6b70dbbc7a32e2bf790) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Add OpenTelemetry traces. With the `opentelemetry` option, `send()` records a `send webhook` producer span under your request's span, and each HTTP attempt records a `deliver webhook` client span linked back to it, so you can get from a request to every attempt at delivering its webhooks. Endpoint URLs (which often carry secrets), baggage and `traceparent` headers to customers are left out on purpose. Webhook requests are sent with tracing suppressed, so HTTP instrumentations (undici, `node:http`) don't record their URLs or add `traceparent` and baggage headers to them, even with `traces: false` (as long as `api` includes `context`). Set `httpInstrumentation: true` to let them trace webhook requests anyway. Migration 5 adds a nullable `messages.trace_context` column; it's only read and written when traces are on. Set `traces: false` for metrics only.

- [#47](https://github.com/NickolasBenakis/hookgres/pull/47) [`8cf3b22`](https://github.com/NickolasBenakis/hookgres/commit/8cf3b22d2914c8e51772831b22c3e07b6cca2884) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Add typed events. Pass one [Standard Schema](https://standardschema.dev) per event type, such as a Zod (3.24+ or 4), Valibot or ArkType schema, as `new Hookgres({ pool, schemas })`, and `send()` is typed from them: a misspelled event type or a payload that doesn't match fails to compile. At runtime, `send()` validates each payload before writing and stores the schema's output, so transforms are applied and, with Zod or Valibot objects, undeclared keys are dropped. An invalid payload throws a `HookgresValidationError` whose message names the failing paths and whose `issues` holds the schema's issues; an event type with no schema, or a schema that throws, also throws a `HookgresValidationError`. Nothing is queued in any of these cases. With `schemas`, `createEndpoint()` and `updateEndpoint()` also reject `eventTypes` that match no declared event type. For compile-time checks only, use `new Hookgres<Events>({ pool })` with an event map. Hookgres still has no runtime dependencies besides `pg`.

  New types: `EventMap`, `AnyEvents`, `EventSchemas`, `EventTypeFilter`, `InferEvents`, `WebhookEvent` (a union of envelopes to narrow on `type` after `verifyWebhook`) and `StandardSchemaV1`. `SendInput`, `CreateEndpointInput` and `UpdateEndpointInput` take an optional event map; without one they're unchanged. New docs page: Typed events.

### Patch Changes

- [#52](https://github.com/NickolasBenakis/hookgres/pull/52) [`8db1e86`](https://github.com/NickolasBenakis/hookgres/commit/8db1e869f17842a3c877cbd9723fc393452f26af) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Fix endpoint auto-disable: when an endpoint is disabled after failing for `disableEndpointAfterMs`, its queued deliveries are now marked `failed` right away, as documented, instead of staying `pending` until their next retry time (up to 10 hours later, or for good with no worker running) and being resent if the endpoint was re-enabled first. The attempt that disables the endpoint, and any attempt recorded after it was disabled automatically, now report `onAttempt` outcome `"failed"` instead of `"retrying"`. Manually disabled endpoints are unchanged. `attemptCount` no longer counts deliveries failed without an HTTP request (endpoint disabled, payload redacted, or out of attempts after a worker crash).

- [#51](https://github.com/NickolasBenakis/hookgres/pull/51) [`97cdfd9`](https://github.com/NickolasBenakis/hookgres/commit/97cdfd9b200f02566776d3b53d183f95d3274f45) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - The package's `AGENTS.md` now lists `fromMikroORM` among the tested ORM wrappers in [Using your ORM's transaction](https://hookgres.dev/docs/guides/orms#mikroorm). The recipe wraps `fromKysely(em.getKysely())`, so `send()` joins an `em.transactional()` transaction in MikroORM 7.

- [#58](https://github.com/NickolasBenakis/hookgres/pull/58) [`78c88b1`](https://github.com/NickolasBenakis/hookgres/commit/78c88b12268be0d7b469ab9674a0a78b3b28d43e) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - The npm description now says what Hookgres is in the words people search for: a transactional outbox for webhooks on Postgres, with webhook delivery signed by Standard Webhooks.

- [#55](https://github.com/NickolasBenakis/hookgres/pull/55) [`df7244e`](https://github.com/NickolasBenakis/hookgres/commit/df7244ebb009bae1f037f7f79e065b5726692f60) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Fix problems found by fuzzing and infrastructure failure testing:
  - Workers recording failed attempts for the same endpoint could deadlock with each other while `send()` calls for it were running, introduced by the lock change in this release cycle. The attempt's result was lost and the delivery resent after `lockTimeoutMs`. The failure is now recorded with a single `UPDATE` of the endpoint, and new `disabled_at` and `disabled_xid` columns (migration 4, catalog only) tell the worker that disabled an endpoint that it was the one.

  - One oversized message could stop every worker. The claim query returned the payload once per claimed delivery, so a large message fanned out to several endpoints could exhaust a worker's memory while it read the result. That aborted the claim, so the same deliveries went to every worker again, forever, and nothing else was delivered. Workers now claim without payloads, then load each message's payload once, as JSON text, and build its request body once for all its deliveries. In a test, peak memory for a 50 MB payload sent to 8 endpoints dropped from about 1.5 GB to about 900 MB. A worker that still runs out of memory has spent the attempt, so the delivery eventually fails instead of blocking the queue. The FAQ documents the memory to budget.
  - The look-past scan that keeps other tenants served behind a full endpoint's backlog is now timed with a monotonic clock, so a wall-clock step back no longer pauses it, and it backs off after an error as well as after finding nothing.
  - Webhook bodies now carry the payload as Postgres stores it (`jsonb` text): `{"a": 1, "b": [1, 2]}` with spaces, and large integers exactly as sent rather than rounded to float64. Receivers that parse JSON are unaffected; ones that compare or hash raw bodies across the upgrade will see different bytes. Signatures cover the exact bytes sent.
  - A worker query that timed out cancelled its statement through the same pool. With every connection busy, for example after a network partition hit all of them at once, the cancels waited for each other and the worker hung for good. The cancel now runs on its own connection outside the pool, bounded at 5 seconds including the connect, and the race timer for a pool checkout is cleared when the checkout fails fast.
  - If preparing a claimed batch failed (a database error putting extra rows back, or loading payloads), its deliveries stayed locked until `lockTimeoutMs` with an attempt spent and nothing sent. They are now put back.

- [#53](https://github.com/NickolasBenakis/hookgres/pull/53) [`3931a9a`](https://github.com/NickolasBenakis/hookgres/commit/3931a9ae577ef897e9cc84ccb37e5073b6a95d16) Thanks [@NickolasBenakis](https://github.com/NickolasBenakis)! - Fix several problems found by running Hookgres under production-like load and failures:
  - With `blockPrivateAddresses`, an endpoint that answered `101 Switching Protocols` hung the attempt forever: `requestTimeoutMs` never fired, the worker stopped delivering for every tenant and `stop()` never returned. Such replies now fail the attempt.
  - Recording a failed attempt took a `FOR UPDATE` lock on the endpoint, which waits for every open transaction that called `send()` for it. Under steady load the worker stalled (in one test 1.2% of webhooks went out), and `drain()` overran its `timeoutMs`. It now takes `FOR NO KEY UPDATE`, which doesn't conflict with them.
  - `send()` failed with a foreign key error, rolling back the caller's transaction, if one of the tenant's endpoints was deleted at the same moment. It now skips the deleted endpoint.
  - `deleteEndpoint()` could deadlock with a worker recording failures for that endpoint. It now deletes the deliveries first and retries the rare remaining deadlock.
  - Every worker query, including its wait for a pool connection, now gives up after `lockTimeoutMs`, so a dead database connection (a network partition) fails to `onError` instead of stalling the worker and `stop()`. The timed-out statement is also cancelled on the server, so it can't commit later. Pools created from `connectionString` turn on TCP keepalive, probing idle connections after 10s.
  - The constructor rejects durations that aren't finite numbers in range, including NaN, and a `concurrency` that isn't a positive integer. These used to pass and leave the worker unable to claim anything, busy-looping, or unable to record failed attempts. Numeric strings (from `process.env`) still work. `listDeliveries`, `rotateEndpointSecret` and `cleanup` reject NaN too, and `verifyWebhook` throws a `TypeError` for a `toleranceSeconds` that is NaN or negative, since NaN turned the replay check off (`Infinity` still turns it off on purpose).
  - `createEndpoint()` and `updateEndpoint()` reject `eventTypes` that isn't an array (a string was split into one-character patterns) and URLs with credentials. Credentials are removed from delivery errors for endpoints stored earlier.
  - `send()` throws a `HookgresValidationError` for a payload that isn't JSON (it was stored as `null`), a string with half a surrogate pair (it was a raw Postgres error) and an `idempotencyKey` over 2000 bytes (longer keys could fail with a raw index error).
  - Endpoint, delivery and attempt dates, and `onAttempt`'s `nextAttemptAt`, are `Date` objects even if your pool parses timestamps as strings.

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
