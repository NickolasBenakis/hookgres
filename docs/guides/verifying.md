# Verifying webhooks

This page is for whoever **receives** the webhooks: your customers, or you
while testing. You can link your customers to it.

Every webhook is a `POST` with a JSON body and three headers, as defined by the
[Standard Webhooks](https://www.standardwebhooks.com) spec:

| Header              | Value                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| `webhook-id`        | The message id, for example `msg_01m6yb1bw7xncca4sw5028556c`. The same on every retry. |
| `webhook-timestamp` | When this attempt was sent, in Unix seconds.                                           |
| `webhook-signature` | One or more space-separated signatures, each `v1,` plus a base64 HMAC-SHA256.          |

```json
{
  "type": "invoice.paid",
  "timestamp": "2026-11-08T15:04:05.000Z",
  "data": { "invoiceId": "in_123", "amount": 4200 }
}
```

## Verify with Hookgres

```ts
import { verifyWebhook, WebhookVerificationError } from "hookgres";

const event = verifyWebhook({
  secret: process.env.WEBHOOK_SECRET!, // whsec_...
  headers: request.headers,
  body: rawBody, // string or Buffer, exactly as received
});
```

`verifyWebhook` returns the parsed body, or throws a `WebhookVerificationError`
if:

- a header is missing, or the timestamp isn't a whole number;
- the timestamp is more than 5 minutes from now, which blocks replayed
  requests (`toleranceSeconds` changes this);
- no signature matches the secret;
- the body isn't valid JSON.

It needs the **raw** body. If your framework already parsed the JSON,
re-serialising it changes the bytes and the signature won't match.

### Express

Register the webhook route **before** any app-wide `express.json()`. Once
`express.json()` has parsed a request, `express.raw()` leaves it alone and
`req.body` is no longer the raw body.

```ts
const app = express();

app.post("/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = verifyWebhook({
      secret,
      headers: req.headers,
      body: req.body,
    });
    res.sendStatus(204);
  } catch {
    res.sendStatus(400);
  }
});

app.use(express.json()); // the rest of your API, after the webhook route
```

### Next.js (App Router)

```ts
// app/api/webhooks/route.ts
export async function POST(request: Request) {
  const body = await request.text();
  try {
    const event = verifyWebhook({ secret, headers: request.headers, body });
    return new Response(null, { status: 204 });
  } catch {
    return new Response("invalid signature", { status: 400 });
  }
}
```

### Hono

```ts
app.post("/webhooks", async (c) => {
  const body = await c.req.text();
  try {
    const event = verifyWebhook({ secret, headers: c.req.raw.headers, body });
    return c.body(null, 204);
  } catch {
    return c.text("invalid signature", 400);
  }
});
```

### Fastify

Register the raw-body parser inside its own plugin, so only the webhook route
gets a `Buffer` and your other routes keep parsed JSON:

```ts
fastify.register(async (webhooks) => {
  webhooks.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  webhooks.post("/webhooks", async (request, reply) => {
    try {
      const event = verifyWebhook({
        secret,
        headers: request.headers,
        body: request.body as Buffer,
      });
      return reply.code(204).send();
    } catch {
      return reply.code(400).send("invalid signature");
    }
  });
});
```

`headers` can be a plain object (Node, Express, Fastify) or a `Headers`
instance (fetch, Next.js, Hono). Header names are matched case-insensitively.

## Verify in other languages

Hookgres follows the Standard Webhooks spec, so receivers can use any of the
official [Standard Webhooks libraries](https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries),
available for JavaScript, Python, Go, Ruby, PHP, Rust, Java, C# and Elixir. Hookgres's test suite checks its signatures against the official
JavaScript library. In Python:

```python
from standardwebhooks.webhooks import Webhook

wh = Webhook(secret)  # "whsec_..."
event = wh.verify(raw_body, headers)
```

To do it by hand: take the base64 part of the secret after `whsec_` and decode
it to get the key. Compute HMAC-SHA256 over
`{webhook-id}.{webhook-timestamp}.{raw body}`, base64-encode it, and compare
it in constant time with each `v1,` signature in the header.

## Deduplicate

Delivery is at least once, and replays reuse the original id. Store the
`webhook-id` of processed webhooks and skip ones you've seen:

```ts
const inserted = await db.query(
  "INSERT INTO processed_webhooks (id) VALUES ($1) ON CONFLICT DO NOTHING",
  [request.headers.get("webhook-id")],
);
if (inserted.rowCount === 0) return new Response(null, { status: 204 }); // seen it
```

## Respond quickly

Answer with a `2xx` as soon as the webhook is verified and stored, and do slow
work afterwards, in a queue. Anything slower than 15 seconds counts as a
failure and is retried. Redirects count as failures too, so make sure the URL
you register is the final one.
