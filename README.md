<div align="center">
  <a href="https://hookgres.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg">
      <img alt="Hookgres" src=".github/assets/logo-light.svg" width="302" height="64">
    </picture>
  </a>

  <h3>Webhooks that commit with your data, from the Postgres you already run.</h3>

  <p>
    <a href="https://www.npmjs.com/package/hookgres"><img alt="npm version" src="https://img.shields.io/npm/v/hookgres?color=163a5f&label=npm"></a>
    <a href="https://www.npmjs.com/package/hookgres"><img alt="npm downloads" src="https://img.shields.io/npm/dm/hookgres?color=163a5f"></a>
    <a href="https://www.npmjs.com/package/hookgres"><img alt="TypeScript types included" src="https://img.shields.io/npm/types/hookgres?color=163a5f"></a>
    <a href="https://github.com/NickolasBenakis/hookgres/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/NickolasBenakis/hookgres/ci.yml?branch=main&label=CI"></a>
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/hookgres?color=163a5f"></a>
  </p>

  <p>
    <a href="https://hookgres.dev">Website</a>
    ·
    <a href="https://hookgres.dev/docs/">Docs</a>
    ·
    <a href="https://hookgres.dev/docs/playground">Playground</a>
    ·
    <a href="https://hookgres.dev/llms.txt">llms.txt</a>
    ·
    <a href="CHANGELOG.md">Changelog</a>
  </p>
</div>

<br>

Hookgres is a TypeScript library that sends webhooks to your customers from
your own Postgres, queued in the same transaction as the data that caused
them. If the row commits, the webhook goes out. If it rolls back, nothing is
sent. Hookgres signs every delivery with
[Standard Webhooks](https://www.standardwebhooks.com), retries failures for
about 28 hours, disables endpoints that stay down, and logs every attempt. It's
the sending half of Svix or Hookdeck as a dependency instead of a vendor: no
extra servers, no queue to run, no per-message bill.

```ts
await hookgres.send(
  { tenantId: "acme", eventType: "invoice.paid", payload: { id: "in_123" } },
  { client }, // your transaction's client: nothing is sent unless you commit
);
```

## Install

```sh
npm install hookgres pg
# or: pnpm add hookgres pg · yarn add hookgres pg · bun add hookgres pg
```

Needs Node.js 22.12+ and Postgres 14+. No Postgres extensions, and no runtime
dependencies besides `pg`. Works with both `import` and `require()`.

Using a coding agent? Give it this line:

```text
Add Hookgres webhooks to this app: hookgres.dev/llms.txt
```

In Claude Code, you can install the Hookgres skill instead:

```text
/plugin install hookgres --marketplace NickolasBenakis/hookgres
```

## Quick start

```ts
import pg from "pg";
import { Hookgres } from "hookgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const hookgres = new Hookgres({ pool });

await hookgres.migrate(); // creates the "hookgres" schema; safe on every boot
hookgres.start(); // delivery worker in this process

// A customer registers an endpoint. Show them endpoint.secret once.
const endpoint = await hookgres.createEndpoint({
  tenantId: "acme",
  url: "https://acme.example.com/webhooks",
  eventTypes: ["invoice.paid"], // omit for every event
});

// Anywhere in your app:
await hookgres.send({
  tenantId: "acme",
  eventType: "invoice.paid",
  payload: { invoiceId: "in_123", amount: 4200 },
  idempotencyKey: "invoice.paid:in_123", // optional, dedupes per tenant
});

await hookgres.stop(); // on shutdown: lets in-flight requests finish
```

### Send inside your transaction

Pass your transaction's client and the webhook is queued in the same commit as
the change that caused it. Roll back and nothing is sent.

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [id]);
  await hookgres.send(
    { tenantId, eventType: "invoice.paid", payload: { id } },
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

### Verify on the receiving side

Receivers get a `POST` with a JSON body (`type`, `timestamp`, `data`) and the
headers `webhook-id`, `webhook-timestamp` and `webhook-signature`. They can
verify it with any Standard Webhooks library, in any language, or with the
helper Hookgres ships:

```ts
import { verifyWebhook } from "hookgres";

app.post("/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  const event = verifyWebhook({
    secret: process.env.WEBHOOK_SECRET!,
    headers: req.headers,
    body: req.body, // the raw body, not parsed JSON
  }); // throws WebhookVerificationError if invalid or older than 5 minutes
  res.sendStatus(204);
});
```

No long-running process? Drain the queue from a cron job with
[`runOnce()`](https://hookgres.dev/docs/guides/workers#cron-or-serverless).

## Features

- **Standard Webhooks signatures.** Receivers verify with `verifyWebhook` or
  any Standard Webhooks library.
- **Transactional outbox.** `send(input, { client })` joins your transaction.
- **Durable retries.** 8 attempts over about 28 hours by default, with jitter
  so failed deliveries don't all retry at once. Workers claim
  deliveries with `FOR UPDATE SKIP LOCKED`, so you can run as many as you like
  without sending a delivery twice.
- **Endpoint health.** An endpoint that fails for 5 days straight is disabled.
  One call re-enables it.
- **Multi-tenant.** Every endpoint and message belongs to a `tenantId`, and an
  event only goes to that tenant's endpoints.
- **Event type filters.** Endpoints subscribe to exact types like
  `invoice.paid` or wildcards like `invoice.*`.
- **Delivery log and replay.** Status code, response body, error and timing for
  every attempt, in tables you can query. `replayDelivery(id)` sends it again.
- **Delivery hooks.** `onAttempt` and `onEndpointDisabled` feed your metrics
  and alerts, for example OpenTelemetry.
- **Instant wake-up.** With `notify: true`, workers in other processes start
  sending as soon as a `send()` commits, using LISTEN/NOTIFY.
- **Secret rotation.** After `rotateEndpointSecret`, the old secret keeps
  signing for a grace period, 24 hours by default.
- **Idempotency keys.** Sending twice with the same key creates one message.
- **Cleanup.** `cleanup({ olderThan })` deletes old, finished messages in
  batches.

## Delivery semantics

| Situation                                         | What happens                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `2xx` response                                    | Succeeded.                                                         |
| Non-`2xx`, redirect, timeout (15s), network error | Retried after 5s, 5m, 30m, 2h, 5h, 10h, 10h, then marked `failed`. |
| Every attempt failing for 5 days                  | Endpoint disabled; its queued deliveries are marked `failed`.      |
| Worker crashes mid-delivery                       | The lock expires and another worker retries it.                    |

Delivery is at least once, so receivers should deduplicate on `webhook-id`.
The schedule, timeout and disable window are all
[configurable](https://hookgres.dev/docs/reference/configuration).

## Hookgres or a hosted service?

|                     | Hookgres                                        | Hosted (Svix Cloud, Hookdeck)     |
| ------------------- | ----------------------------------------------- | --------------------------------- |
| Runs on             | Your app and your Postgres                      | The vendor's cloud                |
| Cost                | MIT licensed, no per-message fees               | A vendor plan                     |
| Atomic with your DB | Yes, `send()` joins your transaction            | No, an API call after your commit |
| Delivery log        | Tables in your database, joinable with your own | The vendor's dashboard and API    |
| Customer portal     | Build it on `listDeliveries` and `listAttempts` | Ready-made                        |
| Regions             | Wherever your workers run                       | The vendor's regions              |

A hosted service suits you better if you need a ready-made customer portal,
delivery from many regions, or want webhook traffic off your database. Coming
from Svix? [The migration guide](https://hookgres.dev/docs/guides/migrating-from-svix)
shows how to keep your customers' secrets.

On pg-boss or graphile-worker already? You can build webhooks on a job queue,
but you'd still need signing, endpoint health, secret rotation, a delivery log
and replay. Hookgres is those parts, built on the same `SKIP LOCKED` technique.

## Performance

On one laptop (Apple Silicon, Postgres 16 in Docker), 4 workers with 50
concurrent requests each delivered 20,000 webhooks to a local receiver at
about 5,500 per second, with none lost or duplicated. `send()` alone queued
about 13,000 messages per second. Run it yourself with `pnpm bench`. In
production, throughput depends mostly on how fast receivers respond.

## Documentation

| Page                                                                     | Covers                                              |
| ------------------------------------------------------------------------ | --------------------------------------------------- |
| [Getting started](https://hookgres.dev/docs/getting-started)             | From install to a verified webhook in five minutes. |
| [Sending webhooks](https://hookgres.dev/docs/guides/sending)             | Transactional sends, idempotency, payloads.         |
| [Verifying webhooks](https://hookgres.dev/docs/guides/verifying)         | Express, Next.js, Hono, Fastify, other languages.   |
| [Retries, failures and replay](https://hookgres.dev/docs/guides/retries) | The schedule, statuses, endpoint health.            |
| [Running workers](https://hookgres.dev/docs/guides/workers)              | Background loop, many workers, cron or serverless.  |
| [Going to production](https://hookgres.dev/docs/guides/production)       | SSRF protection, monitoring, cleanup.               |
| [API reference](https://hookgres.dev/docs/reference/api)                 | Every method, option and type.                      |
| [FAQ](https://hookgres.dev/docs/faq)                                     | Supabase, Neon, ORMs, ordering, payload size.       |

## Try it

The playground runs Postgres and a small app where you send events to three
fake customer endpoints (healthy, flaky and down) and watch deliveries
succeed, retry, fail and get replayed:

```sh
git clone https://github.com/NickolasBenakis/hookgres && cd hookgres
docker compose up # then open http://localhost:3000
```

[`examples/`](examples) has a short runnable file for each feature:
[basic](examples/basic.ts), [transactional](examples/transactional.ts),
[retries and replay](examples/retries-and-replay.ts),
[serverless](examples/serverless.ts) and
[secret rotation](examples/secret-rotation.ts).

## Contributing

Bug reports, docs fixes and pull requests are welcome. CI runs the suite on
every Postgres version from 14 to 18 and on Node.js 22, 24 and 26, and checks
delivered webhooks against the official Standard Webhooks library.

```sh
pnpm install
pnpm test # starts Postgres in Docker via testcontainers, or set DATABASE_URL
pnpm typecheck && pnpm lint
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the full setup and the pull request
checklist.

## Security

Hookgres sends requests to URLs your users provide, so in production you need
to stop them from reaching your internal network. Set
`blockPrivateAddresses: true`; the
[production guide](https://hookgres.dev/docs/guides/production#block-internal-addresses-ssrf)
explains what it checks. Report vulnerabilities privately, as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Nikos Benakis
