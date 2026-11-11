# Using Hookgres with Prisma

This guide shows how to call `send()` inside a Prisma interactive
transaction, so a webhook is queued only if your change commits. It was
tested with Prisma 7 and the `@prisma/adapter-pg` driver adapter.

Why inside? Prisma's own docs list sending from the transaction callback as a
[common mistake](https://www.prisma.io/docs/orm/fundamentals/transactions):
"Database writes roll back; emails don't." Their fix is to send after the
commit, which still loses the webhook if your process stops between the
commit and the send. `send()` doesn't make an HTTP call inside the
transaction. It writes a row, which rolls back with your change, and a
worker delivers it after the commit. See
[Webhooks sent for rolled-back changes](/answers/webhooks-for-rolled-back-changes).

Two separate things are involved:

- **Joining the transaction.** `send()` runs its query through
  `tx.$queryRawUnsafe()`, so it runs on Prisma's transaction connection.
  It works with any driver adapter that supports interactive transactions.
- **Sharing the pool.** Hookgres needs a `pg` pool for `migrate()`, the
  worker and the endpoint API. With `@prisma/adapter-pg`, Prisma can run on
  that same pool. With another adapter or Prisma Accelerate, Hookgres needs
  its own `pg` pool next to Prisma's connections.

## Set up

Install the adapter alongside Hookgres:

```sh
npm install hookgres pg @prisma/adapter-pg
```

Create the pool once and give it to both Prisma and Hookgres, for example in
`db.ts`:

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { Hookgres } from "hookgres";
import pg from "pg";
import { PrismaClient } from "../generated/prisma/client.ts";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
export const hookgres = new Hookgres({ pool });
```

The import path of `PrismaClient` depends on the `output` of your
`prisma-client` generator. The examples use this model:

```prisma
model Invoice {
  id       String @id
  tenantId String @map("tenant_id")
  status   String

  @@map("invoices")
}
```

`send()` accepts any `client` with a node-postgres style
`query(text, values)` method. A Prisma transaction doesn't have one, so wrap
it with `fromPrisma(tx)` from `hookgres/prisma`.

How it works: `fromPrisma()` runs Hookgres's query with
`tx.$queryRawUnsafe(text, ...values)`, on the transaction's connection.
`$queryRawUnsafe` is safe here: the query text is fixed by Hookgres, and the
values are sent as bound parameters, never pasted into the SQL. Hookgres
doesn't depend on Prisma; `fromPrisma()` only calls that one method.

## Send inside a transaction

Use the interactive form of `$transaction`, the one that takes a callback:

```ts
import { fromPrisma } from "hookgres/prisma";
import { hookgres, prisma } from "./db.js";

export async function markPaid(invoiceId: string) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: "paid" },
    });

    return hookgres.send(
      {
        tenantId: invoice.tenantId,
        eventType: "invoice.paid",
        payload: { invoiceId },
      },
      { client: fromPrisma(tx) },
    );
  });
}
```

The update and the webhook commit together. If anything in the callback
throws, Prisma rolls back, and the message and its deliveries are rolled back
with your update:

```ts
export async function markPaidThenFail(invoiceId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: "paid" },
    });
    await hookgres.send(
      { tenantId: "acme", eventType: "invoice.paid", payload: { invoiceId } },
      { client: fromPrisma(tx) },
    );
    throw new Error("Payment provider declined"); // rolls back both
  });
}
```

After this throws, the invoice is still `open` and no message exists.

`fromPrisma()` takes anything with `$queryRawUnsafe`, so it also accepts the
`tx` of a client extended with `$extends`.

## Migrations and workers

Call `hookgres.migrate()` on startup or from a deploy step, as in
[Getting started](/getting-started). It creates its tables in the `hookgres`
schema. Prisma Migrate only manages the schemas your datasource uses
(`public` unless you list others in `schemas`), so it doesn't see them.
Don't add `hookgres` to `schemas` or model its tables in `schema.prisma`;
Hookgres manages its own tables. `prisma migrate reset` can drop schemas in
development, so call `migrate()` again after a reset.

Start the worker with `hookgres.start()` in a long-running process, or call
`drain()` from a cron job. See [Running workers](/guides/workers).
`prisma.$disconnect()` doesn't end a pool you passed to `PrismaPg`, so on
shutdown call `await hookgres.stop()`, then `await prisma.$disconnect()`,
then `await pool.end()`.

## Pitfalls

- **Using `prisma` instead of `tx`.** `fromPrisma(prisma)` runs outside
  your transaction, so the webhook is queued even if the transaction rolls
  back. Pass the `tx` your callback received.
- **Passing the pool.** `send(input, { client: pool })` also runs outside
  Prisma's transaction, even when Prisma uses the same pool.
- **Leaving out `client`.** Without it, `send()` commits on its own right
  away.
- **The array form of `$transaction`.** `prisma.$transaction([a, b])` only
  takes Prisma queries. Use the callback form.
- **Two copies of `pg`.** `PrismaPg` only reuses your pool if it's an
  instance of the `pg` that `@prisma/adapter-pg` loads. If your package
  manager installs a separate copy for the adapter, it treats the pool as
  settings and opens a pool of its own. Transactions still work, but the pool
  isn't shared. Keep one `pg` version in your lockfile.
- **Transaction timeout.** Interactive transactions time out after 5 seconds
  by default. `send()` is one query, but if the callback does slow work, raise
  `timeout` in the `$transaction` options.
- **Errors are Prisma errors.** A database error from `send()` reaches you
  as a `PrismaClientKnownRequestError` (`P2010`), not a `pg` error. For
  example, a `\u0000` in the payload shows up as Postgres error `22P05`
  instead of Hookgres's own message.
- **Pool size.** A transaction holds its connection until it commits, and a
  worker started with `notify: true` holds one more. Size the pool's `max`
  for both.
- **Webhooks go out after commit.** The worker can't see a message until the
  transaction commits, so it picks it up on its next poll (1 second by
  default). Turn on [`notify`](/guides/workers#instant-wake-up-with-listen-notify)
  to wake workers on commit.
