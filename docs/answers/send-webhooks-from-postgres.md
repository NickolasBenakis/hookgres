# How to send webhooks from Postgres

You have a Node.js or TypeScript app on Postgres, and your customers want to
be told when something happens in it: an invoice is paid, an order ships, a
user signs up. This page covers the options and the one most teams get wrong.

## What sending webhooks takes

A webhook is an HTTP `POST` to a URL your customer gives you. Sending one is
a `fetch`. Sending them reliably needs more:

- **A queue that survives restarts**, so an event isn't lost when the process
  dies or the receiver is down.
- **Retries with backoff** for hours, not seconds, because receivers go down
  for deploys and outages.
- **Signatures**, so receivers can tell the request came from you.
- **Endpoint management**: each customer adds URLs, picks event types and
  rotates secrets.
- **A delivery log**, so you and your customers can see what was sent and why
  it failed.
- **Consistency with your data**: the webhook should go out if and only if
  the change that caused it was saved.

## Your options

| Option                                                | What you get                      | What you run                                                    |
| ----------------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `fetch` + a job queue (pg-boss, BullMQ)               | Retries, if you write them        | Your queue, plus signing, health, rotation and a log by hand    |
| A webhook service (Svix, Hookdeck Outpost)            | Everything above, as an API       | Their cloud, or their server plus Redis and more if self-hosted |
| A Postgres library ([Hookgres](https://hookgres.dev)) | Everything above, as a dependency | Nothing new: tables in your existing database                   |

## The part most setups get wrong

Most code sends the webhook after the database write:

```ts
await markInvoicePaid(id); // committed
await webhooks.send("invoice.paid"); // the process crashes, or the API is down
```

If the process dies between those two lines, the invoice is paid and the
customer is never told. Swap them and you get the opposite bug: the webhook
says "paid", then the transaction rolls back.

The fix is the **transactional outbox**: write the event to a table in the
same transaction as the change, and have a worker deliver it after commit.
Postgres makes this simple because the queue can live next to your data.

## With Hookgres

Hookgres is the outbox and the delivery in one TypeScript library.

```sh
npm install hookgres pg
```

```ts
import { Hookgres } from "hookgres";

const hookgres = new Hookgres({ pool, blockPrivateAddresses: true });
await hookgres.migrate(); // creates its own schema; idempotent
hookgres.start(); // the worker: retries, signing, logging

// In the transaction that makes the change:
await client.query("BEGIN");
await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [id]);
await hookgres.send(
  { tenantId: "acme", eventType: "invoice.paid", payload: { id } },
  { client },
);
await client.query("COMMIT"); // queued only if this commits
```

Requests are signed with [Standard Webhooks](https://www.standardwebhooks.com),
retried over about 28 hours, and every attempt is a row you can query.

Next: [Getting started](/getting-started) and
[Sending webhooks](/guides/sending).

## When not to use a Postgres library

- Your backend isn't Node.js.
- You need a ready-made, hosted customer portal today.
- You want webhook traffic off your primary database, or delivery from many
  regions.
