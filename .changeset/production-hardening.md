---
"hookgres": patch
---

Fix several problems found by running Hookgres under production-like load and failures:

- With `blockPrivateAddresses`, an endpoint that answered `101 Switching Protocols` hung the attempt forever: `requestTimeoutMs` never fired, the worker stopped delivering for every tenant and `stop()` never returned. Such replies now fail the attempt.
- Recording a failed attempt took a `FOR UPDATE` lock on the endpoint, which waits for every open transaction that called `send()` for it. Under steady load the worker stalled (in one test 1.2% of webhooks went out), and `drain()` overran its `timeoutMs`. It now takes `FOR NO KEY UPDATE`, which doesn't conflict with them.
- `send()` failed with a foreign key error, rolling back the caller's transaction, if one of the tenant's endpoints was deleted at the same moment. It now skips the deleted endpoint.
- `deleteEndpoint()` could deadlock with a worker recording failures for that endpoint. It now deletes the deliveries first and retries the rare remaining deadlock.
- Every worker query, including its wait for a pool connection, now gives up after `lockTimeoutMs`, so a dead database connection (a network partition) fails to `onError` instead of stalling the worker and `stop()`. The timed-out statement is also cancelled on the server, so it can't commit later. Pools created from `connectionString` turn on TCP keepalive, probing idle connections after 10s.
- The constructor rejects durations that aren't finite numbers in range, including NaN, and a `concurrency` that isn't a positive integer. These used to pass and leave the worker unable to claim anything, busy-looping, or unable to record failed attempts. Numeric strings (from `process.env`) still work. `listDeliveries`, `rotateEndpointSecret` and `cleanup` reject NaN too, and `verifyWebhook` throws a `TypeError` for a `toleranceSeconds` that is NaN or negative, since NaN turned the replay check off (`Infinity` still turns it off on purpose).
- `createEndpoint()` and `updateEndpoint()` reject `eventTypes` that isn't an array (a string was split into one-character patterns) and URLs with credentials. Credentials are removed from delivery errors for endpoints stored earlier.
- `send()` throws a `HookgresValidationError` for a payload that isn't JSON (it was stored as `null`), a string with half a surrogate pair (it was a raw Postgres error) and an `idempotencyKey` over 2000 bytes (longer keys could fail with a raw index error).
- Endpoint, delivery and attempt dates, and `onAttempt`'s `nextAttemptAt`, are `Date` objects even if your pool parses timestamps as strings.
