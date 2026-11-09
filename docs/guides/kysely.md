# Using Hookgres with Kysely

This guide shows how to call `send()` inside a Kysely transaction, so a
webhook is queued only if your change commits. It assumes Kysely's
`PostgresDialect`, which runs on a `pg` pool. Hookgres uses `pg` too, so both
share that pool.

## Set up

Create the pool once and give it to both Kysely and Hookgres, for example in
`db.ts`:

```ts
import { Hookgres } from "hookgres";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

interface Database {
  invoices: { id: string; tenant_id: string; status: string };
}

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});
export const hookgres = new Hookgres({ pool });
```

`send()` accepts any `client` with a node-postgres style
`query(text, values)` method. A Kysely transaction doesn't have one, so wrap
it with `fromKysely(trx)` from `hookgres/kysely`.

How it works: `fromKysely()` runs Hookgres's query through Kysely with
`CompiledQuery.raw()`, on the transaction's connection. The query text and
values come from Hookgres, and the values are sent as bound parameters. It
calls `trx.withoutPlugins()` first, because plugins such as `CamelCasePlugin`
would rename the columns `send()` reads, and the keys inside your payload.
It uses the `kysely` your app installed; Hookgres doesn't depend on it.

## Send inside a transaction

```ts
import { fromKysely } from "hookgres/kysely";
import { db, hookgres } from "./db.js";

export async function markPaid(invoiceId: string) {
  return db.transaction().execute(async (trx) => {
    const invoice = await trx
      .updateTable("invoices")
      .set({ status: "paid" })
      .where("id", "=", invoiceId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return hookgres.send(
      {
        tenantId: invoice.tenant_id,
        eventType: "invoice.paid",
        payload: { invoiceId },
      },
      { client: fromKysely(trx) },
    );
  });
}
```

The update and the webhook commit together. If anything in the callback
throws, Kysely rolls back, and the message and its deliveries are rolled back
with your update:

```ts
export async function markPaidThenFail(invoiceId: string) {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("invoices")
      .set({ status: "paid" })
      .where("id", "=", invoiceId)
      .execute();
    await hookgres.send(
      { tenantId: "acme", eventType: "invoice.paid", payload: { invoiceId } },
      { client: fromKysely(trx) },
    );
    throw new Error("Payment provider declined"); // rolls back both
  });
}
```

After this throws, the invoice is still `open` and no message exists.

`fromKysely()` works the same way with a controlled transaction from
`db.startTransaction()`: pass the `trx` it returns.

## Migrations and workers

Call `hookgres.migrate()` on startup or from a deploy step, as in
[Getting started](/getting-started). It creates its tables in the `hookgres`
schema, separate from your Kysely migrations. Don't write Kysely migrations
for them, and leave them out of your `Database` interface; Hookgres manages
its own tables. If you generate types with a tool that introspects every
schema, exclude `hookgres`.

Start the worker with `hookgres.start()` in a long-running process, or call
`drain()` from a cron job. See [Running workers](/guides/workers).
`db.destroy()` ends the pool you passed to `PostgresDialect`, so on shutdown
call `await hookgres.stop()` first, then `await db.destroy()`, and don't call
`pool.end()` as well.

## Pitfalls

- **Passing `db` instead of `trx`.** `fromKysely(db)` runs on a
  different connection, outside your transaction, so the webhook is queued
  even if the transaction rolls back. Pass the `trx` your callback received.
- **Passing the pool.** `send(input, { client: pool })` has the same
  problem.
- **Leaving out `client`.** Without it, `send()` commits on its own right
  away.
- **Pool size.** A transaction holds its connection until it commits, and a
  worker started with `notify: true` holds one more. Size the pool's `max`
  for both.
- **Webhooks go out after commit.** The worker can't see a message until the
  transaction commits, so it picks it up on its next poll (1 second by
  default). Turn on [`notify`](/guides/workers#instant-wake-up-with-listen-notify)
  to wake workers on commit.
