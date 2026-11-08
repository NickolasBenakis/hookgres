# Hookgres

**Postgres webhooks for TypeScript.** Send signed webhooks to your customers
from the Postgres you already run, with retries, endpoint health, secret
rotation and replay, and without extra servers, queues or per-message bills.

Hookgres is the webhook-sending half of Svix or Hookdeck, as a library:

- **Standard Webhooks signatures.** Receivers can verify with Hookgres's
  `verifyWebhook` or any [Standard Webhooks](https://www.standardwebhooks.com)
  library, in any language.
- **Transactional outbox.** Queue a webhook inside your own transaction; it
  only sends if your transaction commits.
- **Durable retries.** 8 attempts over about 28 hours by default, with
  `FOR UPDATE SKIP LOCKED` so any number of workers can run at once without
  sending a delivery twice.
- **Endpoint health.** Endpoints that fail continuously for 5 days are disabled
  automatically, and re-enabled with one call.
- **Multi-tenant.** Every endpoint and message belongs to a `tenantId` (your
  customer), and each event goes only to that tenant's endpoints.
- **Full delivery log.** Every attempt's status code, response body, error and
  timing is stored for your dashboard and support team.

**[Documentation](https://hookgres.dev/docs/)** · [Getting started](https://hookgres.dev/docs/getting-started) · [Playground](https://hookgres.dev/docs/playground) · [API](https://hookgres.dev/docs/reference/api)

## Install

```sh
npm install hookgres pg
```

Requires Node 22.12+ and Postgres 14+. Works with both `import` and `require()`.

## Quick start

```ts
import pg from "pg";
import { Hookgres } from "hookgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const hookgres = new Hookgres({ pool });

await hookgres.migrate(); // creates the "hookgres" schema; safe to run on every boot
hookgres.start(); // background delivery worker

// Your customer registers an endpoint (show them the secret once).
const endpoint = await hookgres.createEndpoint({
  tenantId: "acme",
  url: "https://acme.example.com/webhooks",
  eventTypes: ["invoice.paid", "invoice.refunded"], // omit for all events
});

// Anywhere in your app:
await hookgres.send({
  tenantId: "acme",
  eventType: "invoice.paid",
  payload: { invoiceId: "in_123", amount: 4200 },
  idempotencyKey: "invoice.paid:in_123", // optional, dedupes per tenant
});

// On shutdown: finishes in-flight deliveries.
await hookgres.stop();
```

### Send inside your transaction

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [id]);
  await hookgres.send(
    { tenantId, eventType: "invoice.paid", payload: { id } },
    { client },
  );
  await client.query("COMMIT"); // webhook is queued only if this commits
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
```

### Serverless or cron instead of a long-running worker

```ts
// e.g. a cron route hit every minute
let processed: number;
do processed = await hookgres.runOnce();
while (processed > 0);
```

## What receivers get

A `POST` with a JSON envelope:

```json
{
  "type": "invoice.paid",
  "timestamp": "2026-11-08T15:04:05.000Z",
  "data": { "invoiceId": "in_123", "amount": 4200 }
}
```

and the Standard Webhooks headers `webhook-id` (the message id, identical
across retries so receivers can deduplicate), `webhook-timestamp` and
`webhook-signature`.

Verifying on the receiving side (needs the raw body):

```ts
import { verifyWebhook } from "hookgres";

app.post("/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  const event = verifyWebhook({
    secret: process.env.WEBHOOK_SECRET!,
    headers: req.headers,
    body: req.body,
  }); // throws WebhookVerificationError if invalid or older than 5 minutes
  res.sendStatus(204);
});
```

## Delivery semantics

| Situation                                         | Behaviour                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `2xx` response                                    | Succeeded.                                                         |
| Non-`2xx`, redirect, timeout (15s), network error | Retried after 5s, 5m, 30m, 2h, 5h, 10h, 10h, then marked `failed`. |
| Every attempt failing for 5 days                  | Endpoint disabled; its queued deliveries are marked `failed`.      |
| Worker crashes mid-delivery                       | The lock expires and another worker retries it.                    |

Delivery is **at least once**: a worker can crash after the receiver
responds but before the result is saved, so receivers should deduplicate on
`webhook-id`.

## API

| Method                                                                                                       | Purpose                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `migrate()`                                                                                                  | Create or upgrade tables (advisory-locked).                             |
| `createEndpoint`, `getEndpoint`, `listEndpoints(tenantId)`, `updateEndpoint`, `deleteEndpoint`               | Manage endpoints. `updateEndpoint(id, { disabled: false })` re-enables. |
| `rotateEndpointSecret(id, { graceMs })`                                                                      | New secret; the old one also signs for `graceMs` (default 24h).         |
| `send(input, { client })`                                                                                    | Queue a message for matching endpoints.                                 |
| `getMessage`, `getDelivery`, `listDeliveries({ messageId, endpointId, status })`, `listAttempts(deliveryId)` | Delivery log.                                                           |
| `replayDelivery(id)`                                                                                         | Re-send a succeeded or failed delivery.                                 |
| `start()`, `stop()`, `runOnce()`, `close()`                                                                  | Worker lifecycle.                                                       |
| `verifyWebhook`, `sign`, `generateSecret`                                                                    | Signing helpers.                                                        |

### Options

```ts
new Hookgres({
  pool, // or connectionString
  schema: "hookgres",
  retrySchedule: [5_000, 300_000 /* ... */], // ms before each retry
  requestTimeoutMs: 15_000,
  disableEndpointAfterMs: 5 * 24 * 3600_000, // null to never disable
  concurrency: 10, // parallel requests per worker
  pollIntervalMs: 1_000,
  fetch, // custom fetch, e.g. with an SSRF guard
  onError: console.error,
});
```

## Security note

Hookgres sends requests to URLs your users provide. In production, stop
endpoints from reaching your internal network (SSRF): pass a `fetch` that
blocks private IP ranges, or route deliveries through an egress proxy. The
[production guide](https://hookgres.dev/docs/guides/production#block-internal-addresses-ssrf)
has an example.

## Performance

One laptop (Apple Silicon, Postgres 16 in Docker), 20,000 webhooks, 4 workers
with 50 concurrent requests each, local receiver:

| Metric                      | Result             |
| --------------------------- | ------------------ |
| `send()` throughput         | ~13,000 messages/s |
| Delivery throughput         | ~5,500 webhooks/s  |
| Lost or duplicated webhooks | 0                  |

Run it yourself with `pnpm bench` (`LOAD_N`, `LOAD_WORKERS` and
`LOAD_CONCURRENCY` to tune). Real-world throughput depends mostly on how fast
receivers respond.

## Try it

The playground runs Postgres and a small web app where you send events to
three fake customer endpoints (one healthy, one flaky, one down) and watch
deliveries succeed, retry, fail and get replayed:

```sh
git clone https://github.com/NickolasBenakis/hookgres && cd hookgres
docker compose up    # then open http://localhost:3000
```

## Examples

Each example is a short runnable file (most share the tiny receiver in
[`examples/receiver.ts`](examples/receiver.ts)). Start Postgres with
`docker compose up -d postgres`, run `pnpm build`, then
`node examples/<file>`. Set `DATABASE_URL` to use your own database.

| Example                                                   | Shows                                                  |
| --------------------------------------------------------- | ------------------------------------------------------ |
| [`basic.ts`](examples/basic.ts)                           | A sender and a verifying receiver in one file.         |
| [`transactional.ts`](examples/transactional.ts)           | A rolled-back transaction sends nothing.               |
| [`retries-and-replay.ts`](examples/retries-and-replay.ts) | Retries, the attempt log, and replaying a delivery.    |
| [`serverless.ts`](examples/serverless.ts)                 | Draining the queue from a cron job with `runOnce()`.   |
| [`secret-rotation.ts`](examples/secret-rotation.ts)       | Rotating a secret without breaking receivers.          |
| [`playground/`](examples/playground)                      | The interactive playground behind `docker compose up`. |

## Development

```sh
pnpm install
pnpm test        # starts Postgres in Docker via testcontainers (or set DATABASE_URL)
pnpm examples    # runs every example and checks the playground (needs DATABASE_URL or docker compose up -d postgres)
pnpm coverage    # tests with coverage thresholds
pnpm typecheck && pnpm lint
pnpm smoke       # packs the library and runs the example from the tarball
pnpm bench       # load test: no lost or duplicated webhooks
pnpm docs:dev    # docs at http://localhost:5173/docs/
pnpm site:build  # landing page + docs in .site-dist/, as deployed to hookgres.dev
```

CI runs the suite on Postgres 14–18 and Node 22, 24 and 26, and checks
webhooks against the official
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks)
library.

## Security

Report vulnerabilities privately to nickolasbenele@gmail.com (see
[SECURITY.md](SECURITY.md)).

## License

[MIT](LICENSE) © Nikos Benakis
