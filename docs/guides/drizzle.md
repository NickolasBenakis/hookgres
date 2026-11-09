# Using Hookgres with Drizzle

This guide shows how to call `send()` inside a Drizzle transaction, so a
webhook is queued only if your change commits. It assumes Drizzle's
node-postgres driver (`drizzle-orm/node-postgres`). Hookgres uses `pg` too, so
both share one connection pool.

## Set up

Create the pool once and give it to both Drizzle and Hookgres, for example in
`db.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Hookgres } from "hookgres";
import pg from "pg";
import * as schema from "./schema.ts";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// Use the same options for both Drizzle instances below.
const options = { schema };

export const db = drizzle({ client: pool, ...options });
export const hookgres = new Hookgres({ pool });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `fn` in a Drizzle transaction on one pooled connection and hands it
 * that connection too, so `hookgres.send(..., { client })` joins the
 * transaction.
 */
export async function transaction<T>(
  fn: (tx: Tx, client: pg.PoolClient) => Promise<T>,
  config?: Parameters<typeof db.transaction>[1],
): Promise<T> {
  const client = await pool.connect();
  try {
    return await drizzle({ client, ...options }).transaction(
      (tx) => fn(tx, client),
      config,
    );
  } finally {
    client.release();
  }
}
```

`send()` joins a transaction when you pass it the `pg` client that runs the
transaction. Drizzle's `tx` object doesn't expose that client, so
`transaction()` above checks one connection out of the pool, builds a Drizzle
instance on it, and starts the transaction there. Drizzle runs a transaction
on the connection it was given, so `tx` and `client` are the same
transaction. Use this helper instead of `db.transaction()` wherever a
transaction sends webhooks; `db` works as before everywhere else.

Both Drizzle instances must be built with the same options. If you pass
`casing`, a `logger` or anything else to `drizzle()`, put it in `options` so
the transaction's queries are built the same way as `db`'s. The second
argument of `transaction()` takes the same settings as `db.transaction()`,
for example `{ isolationLevel: "serializable" }`.

The examples use this table, in `schema.ts`:

```ts
import { pgTable, text } from "drizzle-orm/pg-core";

export const invoices = pgTable("invoices", {
  id: text().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  status: text().notNull(),
});
```

## Send inside a transaction

```ts
import { eq } from "drizzle-orm";
import { hookgres, transaction } from "./db.ts";
import { invoices } from "./schema.ts";

export async function markPaid(invoiceId: string) {
  return transaction(async (tx, client) => {
    const [invoice] = await tx
      .update(invoices)
      .set({ status: "paid" })
      .where(eq(invoices.id, invoiceId))
      .returning();
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

    return hookgres.send(
      {
        tenantId: invoice.tenantId,
        eventType: "invoice.paid",
        payload: { invoiceId },
      },
      { client },
    );
  });
}
```

The update and the webhook commit together. If anything in the callback
throws, Drizzle rolls back, and the message and its deliveries are rolled
back with your update:

```ts
export async function markPaidThenFail(invoiceId: string) {
  await transaction(async (tx, client) => {
    await tx
      .update(invoices)
      .set({ status: "paid" })
      .where(eq(invoices.id, invoiceId));
    await hookgres.send(
      { tenantId: "acme", eventType: "invoice.paid", payload: { invoiceId } },
      { client },
    );
    throw new Error("Payment provider declined"); // rolls back both
  });
}
```

After this throws, the invoice is still `open` and no message exists.

Nested `tx.transaction()` calls use savepoints on the same connection, so a
`send()` inside one rolls back with that savepoint.

## Migrations and workers

Call `hookgres.migrate()` on startup or from a deploy step, as in
[Getting started](/getting-started). It creates its tables in the `hookgres`
schema. drizzle-kit only looks at the schemas in `schemaFilter` (`public` by
default), so it leaves those tables alone. Don't add `hookgres` to
`schemaFilter` or to your Drizzle schema files; Hookgres manages its own
tables.

Start the worker with `hookgres.start()` in a long-running process, or call
`runOnce()` from a cron job. See [Running workers](/guides/workers). On
shutdown, call `await hookgres.stop()` before `await pool.end()`.

## Pitfalls

- **Passing the pool instead of the client.** `send(input, { client: pool })`
  or `{ client: db.$client }` runs on a different connection, outside your
  transaction. The webhook is then queued even if the transaction rolls back.
  Always pass the `client` from `transaction()`.
- **Leaving out `client`.** Without it, `send()` commits on its own right
  away.
- **Reaching into Drizzle internals.** The transaction's connection is a
  private field on `tx`. Don't read it; use the helper above.
- **The postgres.js driver.** This guide doesn't cover
  `drizzle-orm/postgres-js`. Drizzle doesn't expose the connection of its
  transactions, and a postgres.js transaction can't be wrapped in a Drizzle
  instance. Use the node-postgres driver for transactions that send
  webhooks.
- **Pool size.** A transaction holds its connection until it commits, and a
  worker started with `notify: true` holds one more. Size the pool's `max`
  for both.
- **Webhooks go out after commit.** The worker can't see a message until the
  transaction commits, so it picks it up on its next poll (1 second by
  default). Turn on [`notify`](/guides/workers#instant-wake-up-with-listen-notify)
  to wake workers on commit.
