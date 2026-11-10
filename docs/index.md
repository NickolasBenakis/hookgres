# Hookgres docs

Webhooks that commit with your data. Hookgres queues signed, retried webhooks
in the same Postgres transaction as your writes. A TypeScript library, not
another service.

<DocsHub />

## What you get

Hookgres gives you what hosted services like Svix or Hookdeck give you on the
sending side, as a dependency instead of a vendor:

- **Signed requests** using the [Standard Webhooks](https://www.standardwebhooks.com)
  spec, so receivers can verify them in any language.
- **Durable retries** over about 28 hours, with any number of workers sharing
  the queue.
- **Endpoint health**: endpoints that keep failing are disabled automatically.
- **Secret rotation** with a grace period, and **replay** of finished deliveries.
- **A delivery log** of every attempt: status code, response body, error and
  timing.
- **Transactional sends**: queue a webhook inside your own transaction, so it
  only goes out if the transaction commits.

```ts
await hookgres.send({
  tenantId: "acme",
  eventType: "invoice.paid",
  payload: { invoiceId: "in_123", amount: 4200 },
});
```

## How it works

1. `migrate()` creates its tables in their own schema (`hookgres` by
   default): endpoints, messages, deliveries and attempts, plus a table that
   tracks migrations.
2. Your customers register **endpoints**: a URL, the event types they want,
   and a signing secret. Each endpoint belongs to a **tenant**, which is your
   customer's id.
3. `send()` stores a **message** and creates one **delivery** per matching
   endpoint, in a single statement.
4. A **worker**, started with `start()` in any of your processes or run from a
   cron job with `runOnce()`, claims due deliveries with
   `FOR UPDATE SKIP LOCKED`, signs and POSTs them, and records each
   **attempt**. Failures are retried on a schedule. Endpoints failing for days
   are disabled.

There is no separate service to run. Everything lives in your database, where
you can query it, back it up and join it with your own data.

## When to use it

Hookgres is a good fit if you:

- run Node.js 22.12+ and Postgres 14+, and want webhooks without another
  vendor, service or bill;
- send webhooks per customer (multi-tenant) and need retries, signatures and
  a log you can show to support;
- want the webhook to be part of the same transaction as the change that
  caused it.

A hosted service may suit you better if you need a ready-made customer-facing
portal, delivery from many regions, or don't want webhook traffic touching
your database. A customer portal is coming to Hookgres Pro:
[join the waitlist](https://hookgres.dev/#portal).

## What it doesn't do

- **Receive webhooks from third parties.** Hookgres sends them. It does ship
  `verifyWebhook`, which your customers (or you, for testing) can use to
  verify what it sends.
- **Exactly-once delivery.** Delivery is at least once: in rare cases, such as
  a worker crashing after the receiver answered, a webhook is sent twice.
  Receivers deduplicate on the `webhook-id` header.
- **Ordering.** Deliveries are sent roughly in the order they became due, but
  retries mean a later event can arrive before an earlier one.
- **Block internal URLs by default.** Turn on `blockPrivateAddresses` for that; see
  [Going to production](/guides/production#block-internal-addresses-ssrf).
