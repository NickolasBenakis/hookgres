---
"hookgres": patch
---

Fix problems found by fuzzing and infrastructure failure testing:

- Workers recording failed attempts for the same endpoint could deadlock with each other while `send()` calls for it were running, introduced by the lock change in this release cycle. The attempt's result was lost and the delivery resent after `lockTimeoutMs`. The failure is now recorded with a single `UPDATE` of the endpoint, and new `disabled_at` and `disabled_xid` columns (migration 4, catalog only) tell the worker that disabled an endpoint that it was the one.

- One oversized message could stop every worker. The claim query returned the payload once per claimed delivery, so a large message fanned out to several endpoints could exhaust a worker's memory while it read the result. That aborted the claim, so the same deliveries went to every worker again, forever, and nothing else was delivered. Workers now claim without payloads, then load each message's payload once, as JSON text, and build its request body once for all its deliveries. In a test, peak memory for a 50 MB payload sent to 8 endpoints dropped from about 1.5 GB to about 900 MB. A worker that still runs out of memory has spent the attempt, so the delivery eventually fails instead of blocking the queue. The FAQ documents the memory to budget.
- The look-past scan that keeps other tenants served behind a full endpoint's backlog is now timed with a monotonic clock, so a wall-clock step back no longer pauses it, and it backs off after an error as well as after finding nothing.
- Webhook bodies now carry the payload as Postgres stores it (`jsonb` text): `{"a": 1, "b": [1, 2]}` with spaces, and large integers exactly as sent rather than rounded to float64. Receivers that parse JSON are unaffected; ones that compare or hash raw bodies across the upgrade will see different bytes. Signatures cover the exact bytes sent.
- A worker query that timed out cancelled its statement through the same pool. With every connection busy, for example after a network partition hit all of them at once, the cancels waited for each other and the worker hung for good. The cancel now runs on its own connection outside the pool, bounded at 5 seconds including the connect, and the race timer for a pool checkout is cleared when the checkout fails fast.
- If preparing a claimed batch failed (a database error putting extra rows back, or loading payloads), its deliveries stayed locked until `lockTimeoutMs` with an attempt spent and nothing sent. They are now put back.
