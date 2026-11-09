# Transactional outbox for webhooks in Node.js

The transactional outbox pattern makes "save the change" and "publish the
event" happen together or not at all. This page explains the pattern for
webhooks on Postgres and shows a working implementation in Node.js.

## The problem

Two systems, two writes:

```ts
await db.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [id]);
await sendWebhook("invoice.paid", { id }); // separate system
```

There's no way to commit both atomically. A crash, deploy or network error
between them leaves your database and your customers disagreeing. Retrying the
whole function doesn't help: the update already happened.

## The pattern

1. In the same database transaction as the change, insert the event into an
   **outbox** table.
2. Commit. Now the change and the event exist together, or neither does.
3. A **relay** worker reads committed outbox rows, delivers them, and marks
   them done. If it crashes, another worker picks the row up.

Delivery becomes at least once, so receivers deduplicate on an event id.

## Building it yourself

A minimal outbox is a table, an insert in your transaction, and a worker
loop that claims rows with `SELECT ... FOR UPDATE SKIP LOCKED`. For webhooks
you then add per-customer endpoints, event-type filters, signing, retry
backoff over hours, disabling endpoints that keep failing, secret rotation, a
delivery log and replay. That second list is most of the work.

## Using Hookgres

[Hookgres](https://hookgres.dev) is a Postgres outbox with webhook delivery
built in. `send()` is the outbox insert; the worker is the relay.

```ts
import pg from "pg";
import { Hookgres } from "hookgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const hookgres = new Hookgres({ pool, blockPrivateAddresses: true });
await hookgres.migrate();
hookgres.start(); // or runOnce() from a cron route on serverless

async function payInvoice(id: string, tenantId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [
      id,
    ]);
    await hookgres.send(
      {
        tenantId,
        eventType: "invoice.paid",
        payload: { id },
        idempotencyKey: `invoice.paid:${id}`,
      },
      { client },
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

Workers claim deliveries with `SKIP LOCKED`, so you can run as many as you
like. Each request carries a `webhook-id` header for receivers to deduplicate
on.

Using an ORM? `client` can be anything with a node-postgres style
`query(text, values)` that runs inside your transaction. See
[Sending webhooks](/guides/sending#inside-your-transaction).

## Further reading

- [Running workers](/guides/workers): long-running and serverless.
- [Retries, failures and replay](/guides/retries)
- [Database schema](/reference/schema)
