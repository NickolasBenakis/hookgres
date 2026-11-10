# Migrating from Svix

Svix and Hookgres share the same model: applications or tenants, endpoints,
messages, signed deliveries with retries. Both sign with the Standard Webhooks
scheme. Most of a migration is renaming calls. The one change your receivers
will notice is the request body format, covered below.

## Concepts

| Svix                              | Hookgres                      |
| --------------------------------- | ----------------------------- |
| Application (`uid`)               | `tenantId`                    |
| Endpoint                          | Endpoint                      |
| `filterTypes`                     | `eventTypes`                  |
| Message `eventType`               | `eventType`                   |
| Message `payload`                 | `payload`                     |
| Message `eventId`                 | `idempotencyKey`              |
| Message attempt                   | Attempt                       |
| Resend / recover                  | `replayDelivery`              |
| Endpoint secret (`whsec_...`)     | Endpoint secret (`whsec_...`) |
| Channels, transformations, portal | Not built in                  |

A customer portal is coming to Hookgres Pro.
[Join the waitlist](https://hookgres.dev/#portal) for early access.

## Code

```ts
// Svix
await svix.application.create({ name: "Acme", uid: "acme" });
const ep = await svix.endpoint.create("acme", {
  url: "https://acme.example.com/webhooks",
  filterTypes: ["invoice.paid"],
});
await svix.message.create("acme", {
  eventType: "invoice.paid",
  eventId: "evt_123",
  payload: { invoiceId: "in_123" },
});

// Hookgres (no application step: a tenant is just a string)
const endpoint = await hookgres.createEndpoint({
  tenantId: "acme",
  url: "https://acme.example.com/webhooks",
  eventTypes: ["invoice.paid"],
});
await hookgres.send({
  tenantId: "acme",
  eventType: "invoice.paid",
  idempotencyKey: "evt_123",
  payload: { invoiceId: "in_123" },
});
```

## Keep your customers' secrets

Endpoints can be imported with their existing secrets, so receivers don't
have to change anything:

```ts
for (const ep of endpointsExportedFromSvix) {
  await hookgres.createEndpoint({
    tenantId: ep.appUid,
    url: ep.url,
    eventTypes: ep.filterTypes ?? null,
    secret: ep.secret, // whsec_...
  });
}
```

Hookgres accepts `whsec_` secrets of 24 to 64 bytes and rejects anything
else. If an imported secret is rejected, create the endpoint with a new secret
and ask that customer to update theirs.

## What receivers will notice

**Headers.** Hookgres sends `webhook-id`, `webhook-timestamp` and
`webhook-signature`. Svix sends `svix-id`, `svix-timestamp` and
`svix-signature`, with the same values and the same signing scheme. Receivers
using a Standard Webhooks library work unchanged. Receivers reading the
`svix-*` headers themselves need to read the `webhook-*` ones. Check whether
the version of the Svix library they use accepts `webhook-*` headers.

**Body.** Svix posts your payload as the body exactly as you sent it.
Hookgres wraps it in an envelope:

```json
{
  "type": "invoice.paid",
  "timestamp": "2026-11-08T15:04:05.000Z",
  "data": { "invoiceId": "in_123" }
}
```

so receivers find your payload under `data`. Tell your customers before you
switch, or move tenants over gradually while they update.

**Retries.** The default schedule is the same shape as Svix's: 5s, 5m, 30m,
2h, 5h, 10h, 10h.

**Idempotency.** Svix answers a repeated `eventId` with a `409 Conflict`
error. Hookgres doesn't throw: it returns the original message with
`deduplicated: true`, so code that catches Svix's 409 can check that flag
instead. Hookgres keeps an idempotency key for as long as the message exists,
until your [cleanup job](/guides/production#clean-up-old-rows) deletes it.

## Switching over

1. Run Hookgres alongside Svix and import endpoints with their secrets.
2. Tell customers about the body envelope and the header names.
3. Switch `send()` calls per tenant, or all at once, behind a flag.
4. Keep Svix running until its retries have finished, which takes about a
   day.
