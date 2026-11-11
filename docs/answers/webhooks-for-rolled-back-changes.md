# Webhooks sent for rolled-back changes

Your app saves a change and tells a customer's server about it with a
webhook. Those are two writes to two systems, and they can disagree in two
ways:

- **The webhook goes out, the change rolls back.** The customer's ERP marks
  an invoice paid that your database still says is open.
- **The change commits, the webhook never goes out.** The process dies
  between the commit and the send, and nothing remembers to retry.

This page shows both bugs in real projects, why the usual fixes close only
one of them, and what `send()` does instead.

## It happens in mature projects

**Apache Fineract**, the open-source core banking platform, fired webhooks
for batch requests before the batch committed. From
[FINERACT-2570](https://issues.apache.org/jira/browse/FINERACT-2570), March
2026:

> If a later request in the batch fails, the entire batch is rolled back, but
> the webhook for the earlier (now rolled-back) request has already been
> dispatched.
>
> This causes downstream systems that rely on webhooks (e.g. SMS
> notifications) to act on events that never actually persisted.

**NetBox**, the network inventory tool, had the same bug in two places in
August 2026:
[REST API dispatches events for writes that were rolled back](https://github.com/netbox-community/netbox/issues/22978)
and
[UI views leak queued events when a write transaction is rolled back](https://github.com/netbox-community/netbox/issues/22934).
Both are fixed.

**Dodo Payments** hit the other half. Its webhooks were sent and retried from
the application process
([Building webhooks that never fail](https://dodopayments.com/engineering/building-webhooks-never-fail),
January 2026):

> We were losing about 0.3% of our webhooks.

> Schedule a retry for 5 minutes from now, pod gets killed at minute 3, that
> retry never happens.

**Plane** rebuilt its event pipeline around the same constraint
([Building zero-loss event streaming](https://plane.so/blog/building-zero-loss-event-streaming-with-postgresql-django-and-rabbitmq),
February 2026):

> There is no way to atomically write to two independent systems in a single
> operation.

## Why the usual fixes close one gap, not both

**Send after commit.** Fineract's fix defers the webhook to an after-commit
callback, and
[Prisma's docs](https://www.prisma.io/docs/orm/fundamentals/transactions)
give the same advice for side effects: "Database writes roll back; emails
don't." That stops webhooks for rolled-back changes. It doesn't stop the
second bug: if the process dies after the commit and before the callback
runs, the webhook is lost.

**Queue a job inside the transaction.** A job queue in Redis (BullMQ) or any
system outside Postgres doesn't roll back with your data. The job is already
queued when the transaction fails. The
[landing page demo](https://hookgres.dev/#rollback-demo) shows this with real
BullMQ and Postgres.

**Retry in memory.** Dodo's losses came from process deaths: a webhook, or a
retry scheduled in the process, dies with it.

Both bugs go away only when the event is saved **in the same transaction** as
the change, and delivered from there by a worker. Dodo and Plane both ended
up there, with a Postgres trigger writing an events row in the same
transaction. The pattern's name is the
[transactional outbox](/answers/transactional-outbox-nodejs).

## What `send()` does

`send()` inserts the webhook into Hookgres's tables using your transaction's
client:

```ts
await client.query("BEGIN");
await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [id]);
await hookgres.send(
  { tenantId, eventType: "invoice.paid", payload: { id } },
  { client },
);
await client.query("COMMIT");
```

- **Rolls back:** the webhook row rolls back with the invoice. Nothing is
  sent.
- **Commits:** the webhook row is saved with the invoice. A worker delivers
  it, and if the worker or your server dies first, another worker picks it
  up. Retries are rows in Postgres, not timers in a process, so a deploy
  doesn't lose them.
- **Delivered twice:** possible, as with any at-least-once system. Every
  request has a `webhook-id` header that stays the same across retries, so
  receivers can skip duplicates.

Prisma, Drizzle, Kysely, Knex, Sequelize, TypeORM, MikroORM and postgres.js
work too:
see [Using your ORM's transaction](/guides/orms).

## Further reading

- [Sending webhooks](/guides/sending#inside-your-transaction)
- [Transactional outbox in Node.js](/answers/transactional-outbox-nodejs)
- [Retries, failures and replay](/guides/retries)
