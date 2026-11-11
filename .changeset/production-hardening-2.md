---
"hookgres": minor
---

Fix problems found by testing Hookgres at scale and with real integrations:

- A slow or hanging endpoint no longer holds up every other tenant. Workers now refill slots as deliveries finish instead of waiting for a whole batch. A new `maxInFlightPerEndpoint` option (default: half of `concurrency`) limits how many slots one endpoint can take. In a test, one tenant's 100 queued deliveries to a hung endpoint delayed another tenant's webhook by 10s; now it's delivered in about 50ms.
- Claiming due deliveries no longer slows down with the size of the backlog. Each claim read and sorted every due row, which took 235–324ms per batch at 1M due. It now uses the indexes in order: about 10ms.
- A delivery whose keep-alive connection the receiver closed just as it was reused is retried once on a fresh connection, instead of counting as a failed attempt.
- `send()` rejects a payload containing a `Map`, a `Set` (JSON turns both into `{}`) or a `BigInt` with a `HookgresValidationError`. `WebhookEvent` now types each event's `data` as it arrives after JSON, using the new `Jsonified` type: a `Date` schema output is a `string` on the receiver.
- `send({ client })` returns a correct result when the client maps columns to camelCase (for example Knex with `knexSnakeCaseMappers`).
- Docs: the Express receiver recipe registers the webhook route before `express.json()`, which otherwise parses the body first so every signature check fails. The Fastify recipe scopes its raw-body parser to the webhook route.
- `cleanup({ olderThan: ms })` deleted nothing, and webhook envelopes carried a 1970 `timestamp`, when the database used a non-ISO `DateStyle`. Both now use epoch milliseconds internally. The production guide now covers clocks (NTP), `DateStyle`, pool size with several `notify` instances, and rolling upgrades.
