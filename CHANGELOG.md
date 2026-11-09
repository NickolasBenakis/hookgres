# Changelog

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
