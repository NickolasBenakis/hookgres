# Privacy and GDPR

Hookgres stores webhooks in your own Postgres, so the data it holds is
covered by the controls you already have for that database. It adds no new
company that processes your customers' data. This page covers what it
stores, how to keep personal data out, and how to delete it on request.

This is engineering guidance, not legal advice.

## What Hookgres stores

| Where                    | What                                        | Can hold personal data?            |
| ------------------------ | ------------------------------------------- | ---------------------------------- |
| `messages.payload`       | The payload you passed to `send()`          | Yes, if you put it there           |
| `attempts.response_body` | The start of each receiver's response       | Possibly: the receiver controls it |
| `endpoints`              | Customer URLs, description, your `metadata` | Rarely: it's business data         |
| Everything else          | Ids, event types, status codes, timings     | No                                 |

The [schema reference](/reference/schema) lists every column.

## Send ids, not personal data

The simplest protection is to keep personal data out of payloads. Send the
id of what changed, and let the receiver fetch the details from your API:

```ts
// Personal data ends up in the delivery log
await hookgres.send({
  tenantId,
  eventType: "user.updated",
  payload: { email: "anna@example.com", address: "..." },
});

// Only an id: the receiver calls your authenticated API for the details
await hookgres.send({
  tenantId,
  eventType: "user.updated",
  payload: { userId: "usr_123" },
});
```

This also protects you if a webhook secret leaks: the webhook alone reveals
nothing, and fetching the details goes through your API's own access checks.

## Clear payloads after delivery

If payloads must carry personal data, turn on `redactPayloads`:

```ts
const hookgres = new Hookgres({ pool, redactPayloads: true });
```

When a delivery succeeds and it was the last of its message's deliveries
still to succeed, Hookgres sets the message's payload to `null` and
`redactedAt` to the time. Messages that matched no endpoint are redacted
when they're sent. The delivery log stays: status codes, errors and timings
are still there for support.

- Payloads of failed deliveries are kept, so you can fix the endpoint and
  [replay](/guides/retries) them. `cleanup()` removes them at the end of your
  retention period.
- A redacted delivery can't be replayed: `replayDelivery` throws a
  `HookgresValidationError`. Send the event again instead. In the rare case
  that a replay and the redaction run at the same moment, the replay is
  accepted, then marked `failed` with "Payload was redacted" instead of being
  sent.
- Redaction only happens after a success, so `cleanup()` is the backstop
  for the payloads it misses: messages delivered before you turned the
  option on, a message whose failing delivery went away with a deleted
  endpoint, and a worker crash between the success and the redaction.
- Turn it on only once every instance runs a version with this option, and
  after `migrate()` has run. An older worker doesn't know about redaction.

## Limit stored response bodies

Each attempt stores the start of the receiver's response, which helps debug
failures. Receivers decide what they send back, so if that could include
personal data, store less, or nothing:

```ts
new Hookgres({ pool, responseBodyLimit: 0 }); // store no response bodies
new Hookgres({ pool, responseBodyLimit: 256 }); // or just the start
```

The default is 4,096 characters, which is also the maximum.

## Set a retention period

Run [`cleanup()`](/guides/production#clean-up-old-rows) from a daily job to
delete messages, deliveries and attempts older than your retention period:

```ts
await hookgres.cleanup({ olderThan: 30 * 24 * 60 * 60 * 1000 }); // 30 days
```

## Erase on request

`deleteMessages()` deletes the messages that match every filter you give,
with their deliveries and attempts, whatever their status:

```ts
// A person asks to be forgotten
await hookgres.deleteMessages({
  tenantId: "acme",
  payloadContains: { userId: "usr_123" },
});

// A customer leaves: delete their webhook history, then their endpoints
await hookgres.deleteMessages({ tenantId: "acme" });
for (const endpoint of await hookgres.listEndpoints("acme")) {
  await hookgres.deleteEndpoint(endpoint.id);
}
```

- Filters are `tenantId`, `messageIds` and `payloadContains`, combined with
  AND. At least one is required, so a call can't delete everything by
  accident. `payloadContains` can't be empty or contain `undefined`, which
  would match every payload.
- `payloadContains` can't find redacted messages, because their payload is
  gone. With `redactPayloads` on, a delivered message no longer holds the
  person's data, but its attempts may still hold receiver responses: keep
  `responseBodyLimit` low, or erase by `tenantId` or `messageIds` (store the
  message ids you sent about a person if you need that).
- `payloadContains` uses Postgres's `@>`: `{ userId: "usr_123" }` matches
  payloads with that key and value at the top level. Nest the filter to
  match deeper, as in `{ user: { id: "usr_123" } }`. Without `tenantId` it
  scans every message, so it's best for occasional erasure requests. Add a `jsonb_path_ops` GIN index on
  `messages (payload)` if you run it often.
- Pending deliveries of a deleted message are never sent. One already being
  sent may still arrive.
- It returns how many messages it deleted, which you can record as proof of
  the erasure.

## Hookgres or a hosted service, for GDPR

You are responsible for your customers' data either way. With a hosted
webhook service, that service becomes a processor: you sign a data
processing agreement, list it as a subprocessor, and check where it stores
data. It also holds a second copy of payloads that already live in your
database. With Hookgres, there's one copy, in a database you already secure
and already list.

Whichever you use, a webhook sends data to your customer's server. If
payloads include personal data, your agreement with that customer needs to
cover it.
