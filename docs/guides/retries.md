# Retries, failures and replay

## What counts as success

An attempt **succeeds** when the endpoint answers with any `2xx` status within
`requestTimeoutMs` (15 seconds by default).

Everything else is a **failure** and is retried:

- any other status code, including `3xx` redirects (Hookgres doesn't follow
  redirects, so a changed URL shows up as failures instead of silently going
  somewhere else);
- a timeout;
- a network error such as a refused connection, a DNS failure or a TLS error.

## The retry schedule

By default a delivery gets 8 attempts over about 28 hours. After a failed
attempt, the next one waits:

| After attempt | Wait | Total elapsed   |
| ------------- | ---- | --------------- |
| 1             | 5s   | 5s              |
| 2             | 5m   | ~5m             |
| 3             | 30m  | ~35m            |
| 4             | 2h   | ~2.6h           |
| 5             | 5h   | ~7.6h           |
| 6             | 10h  | ~17.6h          |
| 7             | 10h  | ~27.6h          |
| 8             | —    | marked `failed` |

This is the same shape Svix uses. Change it with `retrySchedule`, a list of
waits in milliseconds. The number of attempts is its length plus one:

```ts
new Hookgres({
  pool,
  retrySchedule: [10_000, 60_000, 600_000], // 4 attempts over ~11 minutes
});
```

The schedule is read when each attempt finishes, so changing it affects
deliveries that are already queued too.

## Delivery statuses

| Status       | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `pending`    | Waiting for its next attempt (`nextAttemptAt`).      |
| `delivering` | A worker has claimed it and is sending it right now. |
| `succeeded`  | An attempt got a `2xx`.                              |
| `failed`     | Every attempt failed, or its endpoint was disabled.  |

`lastError` on the delivery holds the most recent failure, such as
`HTTP 500`, `Timed out after 15000ms` or `fetch failed: ECONNREFUSED`.

## The attempt log

Every attempt is stored with its status code, the first 4,096 characters of
the response body, the error, and how long it took:

```ts
const attempts = await hookgres.listAttempts(deliveryId);
// [{ attemptNumber: 1, statusCode: 500, responseBody: "...", error: "HTTP 500", durationMs: 132 }, ...]
```

Combined with `listDeliveries({ endpointId })` or
`listDeliveries({ status: "failed" })`, this is enough to build a delivery
log for your support team or your customers.

## Endpoint health

When an endpoint fails, Hookgres records when the failures started
(`failingSince`). Any successful attempt clears it. If an endpoint keeps
failing for `disableEndpointAfterMs` (5 days by default) with no success in
between, it's **disabled**:

- `disabled` becomes `true`, and `disabledReason` says when the failures
  started;
- new messages skip it;
- deliveries already queued for it are marked `failed` with the error
  `Endpoint is disabled`.

This stops you from retrying forever against a customer who shut down their
server. You might email the tenant when it happens; see
[monitoring](/guides/production#monitoring) for a query that finds them.

The check runs when a failed attempt is recorded, so an endpoint is disabled
on its first failed attempt after the threshold.

Re-enable with:

```ts
await hookgres.updateEndpoint(endpointId, { disabled: false });
```

This clears `failingSince` and `disabledReason`. Deliveries that failed while
it was down aren't resent automatically. Replay the ones you need.

Set `disableEndpointAfterMs: null` to never disable endpoints.

## Replay

```ts
await hookgres.replayDelivery(deliveryId);
```

Replay sends a finished delivery (`succeeded` or `failed`) again, right away,
with a fresh retry schedule. It returns `null` if the delivery doesn't exist
or is still `pending` or `delivering`.

The replayed webhook has the same `webhook-id` and body as the original, so a
receiver that deduplicates will treat it as the same event. That's usually
what you want after an outage. To send an event as new, call `send()` again.

## Crashes and at-least-once delivery

A worker locks each delivery it claims for `lockTimeoutMs` (by default
`requestTimeoutMs` plus 30 seconds). If the worker crashes, the lock expires
and another worker retries the delivery. If a crash happens after the receiver
answered but before the result was saved, the receiver gets the webhook again.

That's why delivery is **at least once**, and why receivers should
deduplicate on `webhook-id`. See [Verifying webhooks](/guides/verifying#deduplicate).
