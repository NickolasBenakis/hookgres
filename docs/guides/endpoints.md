# Endpoints and tenants

A **tenant** is whoever receives your webhooks, usually one of your customers.
Hookgres treats `tenantId` as a plain string, so use whatever id you already
have: an organisation id, an account id, a team slug.

An **endpoint** is one URL a tenant wants webhooks sent to. A tenant can have
any number of endpoints, each with its own event types and secret.

## Create

```ts
const endpoint = await hookgres.createEndpoint({
  tenantId: "acme",
  url: "https://acme.example.com/webhooks",
  description: "Production", // optional
  eventTypes: ["invoice.paid"], // omit or null for every event
  metadata: { createdBy: "user_42" }, // optional, any JSON object
  // secret: "whsec_...",                      // optional, generated if omitted
});
```

The URL must be `http:` or `https:`. `eventTypes` can't be an empty array; use
`null` for "everything".

An event type ending in `.*` is a wildcard. `invoice.*` matches every event
type that starts with `invoice.`, at any depth: `invoice.paid` and
`invoice.line.created`, but not `invoice` itself. The `*` must be the whole
last segment, so `*.paid`, `invoice*` and a bare `*` are rejected. Event
types passed to `send()` can't contain `*`.

The generated secret is `whsec_` followed by 24 random bytes in base64. Show
it to your customer when they create the endpoint, the way Stripe and Svix
do. If you bring your own secret, it must use the same format, with 24 to 64
bytes.

## Read

```ts
await hookgres.getEndpoint("ep_..."); // Endpoint | null
await hookgres.listEndpoints("acme"); // Endpoint[], oldest first
```

`Endpoint` includes `secret`, so only return it to the tenant that owns it.

## Update

```ts
await hookgres.updateEndpoint("ep_...", {
  url: "https://acme.example.com/v2/webhooks",
  eventTypes: null,
  description: null,
  metadata: { createdBy: "user_42", note: "moved to v2" },
});
```

Only the fields you pass change. `metadata` is replaced, not merged. A new
`url` is used for every attempt after the update, including retries of
deliveries already queued. A new `eventTypes` only affects later `send()`
calls.

## Disable and re-enable

```ts
await hookgres.updateEndpoint("ep_...", { disabled: true }); // pause
await hookgres.updateEndpoint("ep_...", { disabled: false }); // resume
```

A disabled endpoint gets no new deliveries. Deliveries already queued for it
are marked `failed` with the error `Endpoint is disabled` when the worker
reaches them.

Hookgres also disables endpoints by itself when every attempt has failed for
5 days. Re-enabling clears the failure state. See
[Retries, failures and replay](/guides/retries#endpoint-health).

## Delete

```ts
await hookgres.deleteEndpoint("ep_..."); // true if it existed
```

This also deletes the endpoint's deliveries and attempts. Messages stay,
because they may have gone to other endpoints.

## Exposing endpoints to customers

Most products give customers a settings page to manage their endpoints. A
typical API, with your own auth deciding the tenant:

```ts
app.post("/api/webhook-endpoints", async (req, res) => {
  const tenantId = req.user.organizationId; // never from the request body
  const endpoint = await hookgres.createEndpoint({
    tenantId,
    url: req.body.url,
    eventTypes: req.body.eventTypes ?? null,
  });
  res.json({ id: endpoint.id, url: endpoint.url, secret: endpoint.secret });
});

app.delete("/api/webhook-endpoints/:id", async (req, res) => {
  const endpoint = await hookgres.getEndpoint(req.params.id);
  if (endpoint?.tenantId !== req.user.organizationId)
    return res.sendStatus(404);
  await hookgres.deleteEndpoint(endpoint.id);
  res.sendStatus(204);
});
```

Always check that an endpoint belongs to the caller's tenant before reading,
changing or deleting it. Hookgres looks endpoints up by id alone.

Before accepting customer URLs in production, read
[Block internal addresses](/guides/production#block-internal-addresses-ssrf).
