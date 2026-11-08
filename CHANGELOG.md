# Changelog

## 0.1.0 (unreleased)

First release.

- Endpoints per tenant with event-type filters, generated or custom
  Standard Webhooks secrets, and secret rotation with a grace period.
- `send()` queues a message and its deliveries in one atomic statement, with
  idempotency keys and optional participation in the caller's transaction.
- Delivery worker using `FOR UPDATE SKIP LOCKED`: retries on a schedule,
  per-claim lock tokens, crash recovery, and automatic endpoint disabling.
- Standard Webhooks signing and `verifyWebhook` for receivers.
- Delivery log (messages, deliveries, attempts) and `replayDelivery`.
