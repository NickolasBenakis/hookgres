---
"hookgres": minor
---

Add the `notify` option (default `false`). With it on, `send()` and `replayDelivery()` run `pg_notify` in the same statement, and each worker started with `start()` holds one pool connection that runs `LISTEN`, so workers in every process wake as soon as a webhook is committed instead of waiting for `pollIntervalMs`. Polling stays as the fallback, and a dropped listener reconnects with backoff. Leave it off behind PgBouncer in transaction mode. Add the `onAttempt` and `onEndpointDisabled` hooks, called after every HTTP attempt and when an endpoint is disabled automatically; errors they throw are reported with `process.emitWarning` and never affect delivery. The `AttemptEvent`, `AttemptOutcome` and `EndpointDisabledEvent` types are exported. `migrate()` now adds an index on `messages (created_at)` so `cleanup()` stays fast on large tables.
