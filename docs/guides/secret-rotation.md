# Rotating secrets

Customers rotate webhook secrets when one leaks, when someone leaves the
team, or on a schedule. Hookgres lets them do it without dropping a single
webhook.

```ts
const endpoint = await hookgres.rotateEndpointSecret("ep_...");
console.log(endpoint?.secret); // the new whsec_... secret
```

## How it works

After a rotation, every webhook is signed with **both** the new secret and the
old one until the grace period ends (24 hours by default). The
`webhook-signature` header then carries two signatures separated by a space:

```
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4= v1,mWvjq3Y1bq7tH0V4X2c+1Q8oZ9RP1d8kHn1vXq9X0yE=
```

A receiver that still has the old secret finds the signature that matches it
and accepts the webhook. When the customer updates their configuration to the
new secret, that matches too. Once the grace period ends, only the new secret
signs.

The flow for your customer:

1. They click "Rotate secret" in your app, and you call
   `rotateEndpointSecret`.
2. You show them the new secret.
3. They deploy it, at any point within the grace period.

## Options

```ts
await hookgres.rotateEndpointSecret("ep_...", {
  graceMs: 0, // end the old secret now, e.g. after a leak
  secret: "whsec_...", // bring your own secret instead of generating one
});
```

The default grace period comes from the `secretRotationGraceMs` option. The
grace period is measured with the database's clock, so it works the same
across all your servers.

Only one previous secret is kept. Rotating again during a grace period ends
the earlier one immediately, so the secret from two rotations ago stops
working at once.

## On the receiving side

During a rotation a receiver can also accept both secrets itself, which helps
when it can't switch secrets atomically:

```ts
verifyWebhook({
  secret: [process.env.WEBHOOK_SECRET!, process.env.WEBHOOK_SECRET_OLD!],
  headers,
  body,
});
```

It accepts the webhook if any signature matches any of the secrets.
