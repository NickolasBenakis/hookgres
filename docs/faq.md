# FAQ

## Is it free?

Yes. Hookgres is MIT licensed. There are no per-message fees, because it runs
on your own database.

## Does it work with Supabase, Neon, RDS, Cloud SQL...?

It should work with any Postgres 14+. Hookgres uses plain SQL and needs no
extensions. CI tests it on Postgres 14, 15, 16, 17 and 18.

By default it also uses no session state: no named prepared statements, only
transaction-level advisory locks, and no `LISTEN` unless you turn on
[`notify`](/guides/workers#instant-wake-up-with-listen-notify). So it should
work through a pooler in transaction mode, such as PgBouncer or Supavisor;
leave `notify` off there. Pooler setups aren't part of CI yet.

## Can I use it with Prisma, Drizzle, Kysely or another ORM?

Yes. Hookgres needs a `pg.Pool` for itself; your ORM can keep its own
connection. For [transactional sends](/guides/sending#inside-your-transaction),
pass `send()` a client with a node-postgres style `query(text, values)` method
that runs inside your transaction. `hookgres/prisma` and `hookgres/kysely`
export one, and [Using your ORM's transaction](/guides/orms) has tested
recipes of a few lines for Drizzle, postgres.js, Knex, Sequelize and TypeORM.
If your stack has no transactions, call `send()` right after the change is
saved instead. You lose the outbox guarantee, but everything else works.

## Is delivery exactly once?

No, at least once. A worker can crash after the receiver answered but before
the result was saved, and then the webhook is sent again. This is true of
every webhook system, which is why receivers should deduplicate on
`webhook-id`.

## Are webhooks delivered in order?

Not strictly. Deliveries are claimed roughly in the order they become due,
and several are sent in parallel, so retries let later events overtake
earlier ones. If order matters, include a version or timestamp in the
payload, or have receivers fetch the current state.

## How do I show customers their delivery history?

Use `listDeliveries({ endpointId })` and `listAttempts(deliveryId)`, or query
the [tables](/reference/schema) directly. The
[playground](/playground) source is a small working example of a delivery
dashboard.

## Can it receive webhooks from Stripe, GitHub and others?

No. Hookgres is for sending. `verifyWebhook` exists so receivers, including
your own tests, can check what Hookgres sends.

## How big can payloads be?

Postgres allows large `jsonb` values, but keep webhooks small, well under a
megabyte. Large bodies slow down every retry, and many receivers reject them.
A common pattern is to send ids and let the receiver fetch the details.

## Does it run on Bun or Deno?

It's built and tested for Node.js 22.12+. Other runtimes with node-postgres
and `fetch` may work, but they aren't tested.

## Why Standard Webhooks?

It's an open spec, adopted by Svix and others. It comes with verification
libraries in many languages, so your customers don't need anything from you to
verify webhooks.

## Why not just use a job queue?

You can build webhooks on pg-boss or graphile-worker. You'd then still need
signing, per-endpoint health, auto-disable, secret rotation, a delivery log
and replay. Hookgres is those parts, built on the same `SKIP LOCKED`
technique.

## What about GDPR?

Webhooks stay in your own Postgres, so Hookgres adds no new processor of
your customers' data. Keep personal data out of payloads by sending ids,
turn on `redactPayloads` to clear payloads after delivery, set a retention
period with `cleanup()`, and erase on request with `deleteMessages()`. See
[Privacy and GDPR](/guides/privacy).

## Will webhooks slow down my database?

For most apps, no. A webhook costs about 2 SQL statements, 1.3 KB of table
and index space and 3.3 KB of WAL, and an idle worker runs one small query
a second. [Database cost](/guides/database-cost) has the measurements, and
how to keep tables small with `cleanup()`.

## Can webhooks come from fixed IP addresses?

Yes. Workers send webhooks from your own servers, so run them behind a NAT
gateway or static egress IP, or send through a proxy with the `fetch`
option. See [Fixed IPs and data residency](/guides/ips-and-regions).

## Can I keep each tenant's data in their region?

Yes. Everything is stored in your database, so it stays in that database's
region. With regional databases, create one Hookgres instance per region and
run workers there. See
[Data residency](/guides/ips-and-regions#data-residency).

## Something's wrong. Where do I look?

1. `listDeliveries({ status: "failed" })` and `listAttempts` show exactly what
   each endpoint answered.
2. `onError` logs problems with the worker itself.
3. The [monitoring queries](/guides/production#monitoring) show the backlog
   and failing endpoints.

Still stuck? [Open an issue](https://github.com/NickolasBenakis/hookgres/issues).
