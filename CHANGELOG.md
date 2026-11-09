# Changelog

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
