# When you need to send webhooks

You need webhooks when **another company's software has to react to
something that happens in your app**. It usually starts with a customer
asking: "Can you tell our system when this happens, instead of us polling your
API?"

If no customer has asked that yet, you probably don't need Hookgres. If you
only _receive_ webhooks (from Stripe, GitHub or Clerk), use their verification
library instead.

Below are six everyday cases. Each links to a product you know that sends
these webhooks, and shows the one `send()` call that adds them to your app.
Every example runs inside the transaction that saves the change, so a webhook
goes out only if the change commits.

## Bookings → your customer's CRM

**You build:** a scheduling or booking app.
**Your customer asks:** "When someone books a demo with our sales team, put
them in our CRM."
**Like:** [Cal.com webhooks](https://cal.com/docs/developing/guides/automation/webhooks)
(`BOOKING_CREATED`, `BOOKING_CANCELLED`).

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query(
    "INSERT INTO bookings (team_id, email, starts_at) VALUES ($1, $2, $3) RETURNING *",
    [teamId, email, startsAt],
  );
  await hookgres.send(
    { tenantId: teamId, eventType: "booking.created", payload: rows[0] },
    { client },
  );
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
```

The other examples show only the `send()` call; `client` is the same
transaction client. [Drizzle](/guides/drizzle), [Prisma](/guides/prisma) and
[Kysely](/guides/kysely) work too.

A booking that fails to save never reaches the CRM, and one that saves always
does, even if your server restarts a second later.

## Invoices → your customer's accounting system

**You build:** invoicing, billing or payments.
**Your customer asks:** "Mark the invoice paid in our ERP the moment it's
paid."
**Like:** [Stripe webhooks](https://docs.stripe.com/webhooks) (`invoice.paid`).

```ts
await hookgres.send(
  {
    tenantId: invoice.accountId,
    eventType: "invoice.paid",
    payload: { id: invoice.id, amount: invoice.amount },
    idempotencyKey: `invoice.paid:${invoice.id}`,
  },
  { client },
);
```

Money is where a webhook for a rolled-back change hurts most: the customer's
ERP books a payment you don't have. The idempotency key also stops a retried
request from sending it twice.

## Long jobs → no more polling

**You build:** an AI, transcription, video or report API where a job takes
seconds to minutes.
**Your customer asks:** "Call us when it's done; we don't want to poll every
second."
**Like:** [Replicate webhooks](https://replicate.com/docs/topics/webhooks)
(prediction finished).

```ts
await hookgres.send(
  {
    tenantId: job.customerId,
    eventType: job.ok ? "job.completed" : "job.failed",
    payload: { id: job.id, outputUrl: job.outputUrl },
  },
  { client },
);
```

Polling costs you an API request every few seconds per waiting job; a webhook
costs one request per job. If the customer's server is down when the job
finishes, Hookgres retries for about 28 hours.

## Form answers → Zapier, Make and n8n

**You build:** forms, surveys, sign-ups, or anything users want to automate.
**Your customer asks:** "Do you have a Zapier integration?"
**Like:** [Tally webhooks](https://tally.so/help/webhooks) and
[Zapier instant triggers](https://docs.zapier.com/integrations/build/cli-hook-trigger),
which Zapier builds on webhooks.

```ts
// A customer pastes a Zapier, Make or n8n webhook URL in your settings page:
await hookgres.createEndpoint({
  tenantId: form.workspaceId,
  url: zapierHookUrl,
  eventTypes: ["form.submitted"],
});

// Each answer then triggers their automation:
await hookgres.send(
  { tenantId: form.workspaceId, eventType: "form.submitted", payload: answer },
  { client },
);
```

One webhook endpoint setting connects your product to thousands of apps
through those tools, without building each integration.

## Orders → the merchant's warehouse

**You build:** e-commerce, a marketplace, or a platform that sells for others.
**Your customer asks:** "Tell our warehouse system when an order is paid, and
when it's refunded."
**Like:** [Shopify webhooks](https://shopify.dev/docs/apps/build/webhooks)
(`orders/create`, `refunds/create`).

```ts
await hookgres.send(
  { tenantId: order.merchantId, eventType: "order.paid", payload: order },
  { client },
);
```

Each merchant adds their own endpoints and picks the events they want; a
merchant whose server stays down gets its endpoint disabled instead of
retrying forever.

## Email events → your customer's app

**You build:** an API that sends things for customers: email, SMS, push
notifications.
**Your customer asks:** "Tell us when an email bounces so we stop sending to
that address."
**Like:** [Resend webhooks](https://resend.com/docs/webhooks/introduction)
(`email.bounced`, `email.delivered`), which Resend sends through Svix
([its verification docs](https://resend.com/docs/webhooks/verify-webhooks-requests)
use the `svix-*` headers).

```ts
await hookgres.send(
  {
    tenantId: message.accountId,
    eventType: "email.bounced",
    payload: { emailId: message.id, to: message.to },
  },
  { client },
);
```

These are high-volume events, which is where a per-message bill grows fastest.
At 10 million events a month, Svix lists $1,015 a month; the same webhooks in
your Postgres take about 13 GB. See [Cost comparison](/compare).

## What every case gets

- **Signed** with [Standard Webhooks](/guides/verifying), so customers verify
  them with a library in their language.
- **Retried** with backoff for about 28 hours, then marked failed and
  [replayable](/guides/retries).
- **Logged:** every attempt is a row you can query, show in your UI, or use
  to answer "did you send it?"
- **Per customer:** endpoints belong to a tenant, with their own secrets and
  [rotation](/guides/secret-rotation).

[Get started](/getting-started), or give your coding agent:
`Add Hookgres webhooks to this app: hookgres.dev/llms.txt`
