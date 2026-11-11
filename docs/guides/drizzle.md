# Using Hookgres with Drizzle

This guide shows how to call `send()` inside a Drizzle transaction, so a
webhook is queued only if your change commits. It works with Drizzle's
node-postgres and postgres.js drivers.

## Set up

Hookgres needs a `pg` pool of its own. With the node-postgres driver, Drizzle
can share it, for example in `db.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Hookgres } from "hookgres";
import pg from "pg";
import * as schema from "./schema.js";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle({ client: pool, schema });
export const hookgres = new Hookgres({ pool });
```

With the postgres.js driver, keep your `postgres()` client for Drizzle and give
Hookgres a small `pg` pool on the same `DATABASE_URL`
(`npm install hookgres pg`).

`send()` takes a `client` with a node-postgres style `query(text, values)`
method that runs on your transaction. Drizzle's `tx` doesn't have one, so copy
this wrapper into `db.ts` too:

<<< @/snippets/orms/drizzle.ts

How it works: `fromDrizzle()` turns Hookgres's query into Drizzle SQL with the
values as bound parameters, and runs it with `tx.execute()` on the
transaction's connection. Raw queries skip Drizzle's column mapping, so a
`casing` setting doesn't rename the columns `send()` reads. Hookgres's CI runs
this exact wrapper on both drivers, and with `casing` set. Other stacks are in
[Using your ORM's transaction](/guides/orms).

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
import { db, fromDrizzle, hookgres } from "./db.js";
import { invoices } from "./schema.js";

export async function markPaid(invoiceId: string) {
  return db.transaction(async (tx) => {
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
      { client: fromDrizzle(tx) },
    );
  });
}
```

The update and the webhook commit together. If anything in the callback
throws, Drizzle rolls back, and the message and its deliveries are rolled
back with your update:

```ts
export async function markPaidThenFail(invoiceId: string) {
  await db.transaction(async (tx) => {
    await tx
      .update(invoices)
      .set({ status: "paid" })
      .where(eq(invoices.id, invoiceId));
    await hookgres.send(
      { tenantId: "acme", eventType: "invoice.paid", payload: { invoiceId } },
      { client: fromDrizzle(tx) },
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
`drain()` from a cron job. See [Running workers](/guides/workers). On
shutdown, call `await hookgres.stop()` before `await pool.end()`.

## Pitfalls

- **Wrapping `db` instead of `tx`.** `fromDrizzle(db)` or `{ client: pool }`
  runs on a different connection, outside your transaction. The webhook is
  then queued even if the transaction rolls back. Always wrap the `tx` your
  callback receives.
- **Leaving out `client`.** Without it, `send()` commits on its own right
  away.
- **`neon-http`.** That driver has no interactive transactions, so there's no
  `tx` to join. Use `neon-serverless`, or send after the change is saved.
- **Pool size.** A transaction holds its connection until it commits, and a
  worker started with `notify: true` holds one more. Size the pool's `max`
  for both.
- **Webhooks go out after commit.** The worker can't see a message until the
  transaction commits, so it picks it up on its next poll (1 second by
  default). Turn on [`notify`](/guides/workers#instant-wake-up-with-listen-notify)
  to wake workers on commit.
