# Sending webhooks

```ts
const result = await hookgres.send({
  tenantId: "acme",
  eventType: "invoice.paid",
  payload: { invoiceId: "in_123", amount: 4200 },
  idempotencyKey: "invoice.paid:in_123", // optional
});
```

`send()` writes the message and one delivery per matching endpoint in a
single statement, then returns:

| Field           | Meaning                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| `message`       | The stored message, with its `msg_...` id.                                |
| `deliveryCount` | How many endpoints it was queued for.                                     |
| `deduplicated`  | `true` if the idempotency key was used before and nothing new was queued. |

An endpoint matches when it belongs to the same `tenantId`, is enabled, and
either subscribes to `eventType`, to a wildcard that covers it (like
`invoice.*`), or to every event (`eventTypes: null`). If no
endpoint matches, the message is still stored and `deliveryCount` is `0`.
Endpoints created later don't receive earlier messages.

## Inside your transaction

The most common webhook bug is sending an event for a change that was then
rolled back, or saving a change and failing to send its event. Pass your
transaction's client to `send()` and both happen or neither does. This is the
**transactional outbox** pattern:

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [id]);
  await hookgres.send(
    { tenantId, eventType: "invoice.paid", payload: { id } },
    { client },
  );
  await client.query("COMMIT"); // the webhook is queued only if this commits
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
```

`client` can be anything with a node-postgres style
`query(text, values)` method, so most query builders work if they let you
reach the underlying client of a transaction.

Webhooks sent this way go out on the worker's next poll (within
`pollIntervalMs`, 1 second by default), because the worker can't see them
until you commit.

::: tip Same database
The transactional guarantee needs Hookgres's tables in the same database as
your data. They live in their own schema, so they don't mix with your tables.
:::

### Using an ORM

If your app makes its changes through an ORM or another driver, `send()`
needs a client that runs on that transaction: anything with a
`query(text, values)` method that returns `{ rows }`. Hookgres ships one for
Prisma (`hookgres/prisma`) and Kysely (`hookgres/kysely`), and
[Using your ORM's transaction](/guides/orms) has tested recipes of a few lines
for Drizzle, postgres.js, Knex, Sequelize and TypeORM. Guides:

- [Drizzle](/guides/drizzle)
- [Prisma](/guides/prisma)
- [Kysely](/guides/kysely)

## Idempotency

Set `idempotencyKey` when the same event could be sent more than once, for
example from a job that may retry. A second `send()` with the same key for the
same tenant returns the original message with `deduplicated: true` and queues
nothing.

```ts
await hookgres.send({
  tenantId: "acme",
  eventType: "invoice.paid",
  payload: { invoiceId: "in_123" },
  idempotencyKey: `invoice.paid:in_123`,
});
```

Keys are unique per tenant for as long as the message exists. If you delete
old messages (see [cleanup](/guides/production#clean-up-old-rows)), their keys
become usable again.

## Event types

Event types are free-form strings, except that they can't contain `*`. A
`resource.action` style such as `invoice.paid` is the usual convention.
Endpoints list the types they want, or `null` for all of them. An entry like
`invoice.*` matches every event type under `invoice.`. See
[Endpoints](/guides/endpoints#create).

To have TypeScript check event types and payloads, and optionally validate
payloads with Zod or Valibot, see [Typed events](/guides/typed-events).

## Payloads

The payload can be any JSON-serialisable value. It's stored as `jsonb` and
delivered as `data` inside the envelope. Prefer ids over personal data; see
[Privacy and GDPR](/guides/privacy):

```json
{
  "type": "invoice.paid",
  "timestamp": "2026-11-08T15:04:05.000Z",
  "data": { "invoiceId": "in_123", "amount": 4200 }
}
```

`timestamp` is when the message was created, so it stays the same across
retries.

A few things to know:

- Because the payload is stored as `jsonb`, key order and whitespace aren't
  preserved, and a `\u0000` character is rejected by Postgres.
- Keep payloads small. Many senders include just an id and let the receiver
  fetch the full object, which also avoids sending stale data on a late retry.
- `undefined` is not a valid payload. Use `{}` or `null`.
