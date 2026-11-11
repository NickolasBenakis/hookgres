# Using your ORM's transaction

`send()` joins whatever transaction your app is already in. It needs one
thing from it: a `client` with a `query(text, values)` method that runs SQL on
that transaction and returns `{ rows }`. That's the node-postgres interface,
so a `pg` client works as it is, and any other driver or ORM needs a wrapper
of a few lines.

| You use              | Pass as `client`                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `pg` (node-postgres) | The transaction's client, as it is ([Sending webhooks](/guides/sending#inside-your-transaction)) |
| Prisma               | `fromPrisma(tx)` from `hookgres/prisma` ([guide](/guides/prisma))                                |
| Kysely               | `fromKysely(trx)` from `hookgres/kysely` ([guide](/guides/kysely))                               |
| Drizzle              | `fromDrizzle(tx)`, the recipe below ([guide](/guides/drizzle))                                   |
| postgres.js          | `fromPostgresJs(tx)`, below                                                                      |
| Knex                 | `fromKnex(trx)`, below                                                                           |
| Sequelize            | `fromSequelize(sequelize, t)`, below                                                             |
| TypeORM              | `fromTypeORM(queryRunner)`, below                                                                |
| MikroORM             | `fromMikroORM(em)`, below                                                                        |

The recipes are meant to be copied into your app, for example into `db.ts`.
Hookgres doesn't ship them, so it doesn't depend on any ORM or follow its
releases. Each recipe on this page runs in Hookgres's CI against a real
Postgres: a commit must queue the webhook, a rollback must queue nothing, and
a repeated idempotency key must be deduplicated.

Hookgres itself still needs a `pg.Pool` for its workers and for `send()`
calls without a `client`, even when your app talks to the database through
another driver. `npm install hookgres pg`, and give it the same
`DATABASE_URL`.

## Drizzle

Tested with Drizzle's node-postgres and postgres.js drivers. It should work
with any Drizzle driver that has interactive transactions; `neon-http` has
none, so use `neon-serverless` there.

<<< @/snippets/orms/drizzle.ts

```ts
await db.transaction(async (tx) => {
  await tx.update(invoices).set({ status: "paid" }).where(eq(invoices.id, id));
  await hookgres.send(
    { tenantId, eventType: "invoice.paid", payload: { id } },
    { client: fromDrizzle(tx) },
  );
});
```

More in the [Drizzle guide](/guides/drizzle).

## postgres.js

<<< @/snippets/orms/postgres-js.ts

```ts
await sql.begin(async (tx) => {
  await tx`UPDATE invoices SET status = 'paid' WHERE id = ${id}`;
  await hookgres.send(
    { tenantId, eventType: "invoice.paid", payload: { id } },
    { client: fromPostgresJs(tx) },
  );
});
```

## Knex

Knex binds `?` placeholders, so the recipe turns Hookgres's `$1`, `$2`
placeholders into `?` and escapes any literal `?`.

<<< @/snippets/orms/knex.ts

```ts
await knex.transaction(async (trx) => {
  await trx("invoices").where({ id }).update({ status: "paid" });
  await hookgres.send(
    { tenantId, eventType: "invoice.paid", payload: { id } },
    { client: fromKnex(trx) },
  );
});
```

## Sequelize

<<< @/snippets/orms/sequelize.ts

```ts
await sequelize.transaction(async (t) => {
  await Invoice.update({ status: "paid" }, { where: { id }, transaction: t });
  await hookgres.send(
    { tenantId, eventType: "invoice.paid", payload: { id } },
    { client: fromSequelize(sequelize, t) },
  );
});
```

## TypeORM

<<< @/snippets/orms/typeorm.ts

```ts
await dataSource.transaction(async (manager) => {
  await manager.update(Invoice, { id }, { status: "paid" });
  await hookgres.send(
    { tenantId, eventType: "invoice.paid", payload: { id } },
    { client: fromTypeORM(manager.queryRunner!) },
  );
});
```

## MikroORM

MikroORM 7 runs its SQL through Kysely, and `em.getKysely()` inside
`em.transactional()` is bound to the transaction. So the recipe reuses
`fromKysely` from `hookgres/kysely`, which sends the values as bound
parameters.

<<< @/snippets/orms/mikro-orm.ts

```ts
await em.transactional(async (em) => {
  const invoice = await em.findOneOrFail(Invoice, id);
  invoice.status = "paid";
  await em.flush();
  await hookgres.send(
    { tenantId, eventType: "invoice.paid", payload: { id } },
    { client: fromMikroORM(em) },
  );
});
```

Pass the `em` that `transactional()` gives you. `em.fork()` would run
outside the transaction.

`hookgres/kysely` imports `kysely`, which MikroORM already installs. If your
package manager doesn't hoist dependencies (Yarn Plug'n'Play, or pnpm with
`hoist=false`), add `kysely` to your own dependencies too.

## Another driver or ORM

Write the same wrapper. It has to:

1. Run the SQL **on the transaction's own connection**. A wrapper around the
   pool or the ORM's top-level client runs outside the transaction, so a
   rollback no longer removes the webhook.
2. Send `values` as bound parameters for `$1`, `$2`, ... (rewrite them if your
   driver uses `?`, as the Knex recipe does). Send string values as plain
   text: Hookgres passes the payload already JSON-encoded, and a driver that
   JSON-encodes `jsonb` parameters itself would store it as a string. The
   postgres.js recipe shows the fix.
3. Return `{ rows }` with the rows as Postgres sent them. Turn off anything
   that renames columns, such as camel-case plugins: `send()` reads Hookgres's
   own column names. Timestamps can come back as `Date` objects or strings;
   Hookgres parses both.

To test it, send inside a transaction and check that `hookgres.messages` has
the payload as a JSON object, then roll one back and check that nothing was
added.

If your stack has no transactions at all, such as the Supabase JavaScript
client, call `send()` after the change is saved instead. You lose the
guarantee that the webhook commits with your data, but everything else
works.
