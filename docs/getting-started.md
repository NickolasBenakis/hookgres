# Getting started

This page takes you from install to a verified webhook in about five minutes.

## Requirements

- Node.js **22.12** or newer. Hookgres works with both `import` and `require()`.
- Postgres **14** or newer. No extensions are needed.
- The [`pg`](https://node-postgres.com) driver, which Hookgres uses for
  connections.

## Using a coding agent

Claude Code, Codex, Cursor, Gemini CLI and other coding agents can set Hookgres
up for you. Give your agent this line:

```text
Add Hookgres webhooks to this app: hookgres.dev/llms.txt
```

For more control, give it the full prompt instead:

```text
Add Hookgres (https://hookgres.dev) to this project so we can send signed webhooks to our customers. First read https://hookgres.dev/llms.txt. Then install hookgres and pg, run migrate() on startup, start the delivery worker with a graceful shutdown, add API routes for customers to manage their webhook endpoints scoped to their tenant, and call send() inside our existing database transactions where events happen. Pass blockPrivateAddresses: true so customer URLs can't reach private or internal addresses.
```

In Claude Code, you can install the Hookgres skill instead:

```text
/plugin marketplace add NickolasBenakis/hookgres
/plugin install hookgres@hookgres
```

Once installed, the package also ships `AGENTS.md` and `llms.txt` in
`node_modules/hookgres/`, so agents can read the integration steps offline.
Review what the agent writes against the steps below.

## Install

::: code-group

```sh [npm]
npm install hookgres pg
```

```sh [pnpm]
pnpm add hookgres pg
```

```sh [yarn]
yarn add hookgres pg
```

```sh [bun]
bun add hookgres pg
```

:::

The package is [`hookgres` on npm](https://www.npmjs.com/package/hookgres).
It ships its own TypeScript types. `pg` is a peer dependency, so install it
alongside, as above. Any of these package managers works, but Hookgres runs on
Node.js; [other runtimes aren't tested](/faq#does-it-run-on-bun-or-deno).

Need a database? The repository's `docker-compose.yml` starts one:

```sh
docker compose up -d postgres
# postgres://postgres:postgres@localhost:5432/postgres
```

## 1. Create the tables

```ts
import pg from "pg";
import { Hookgres } from "hookgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const hookgres = new Hookgres({ pool });

await hookgres.migrate();
```

`migrate()` creates the `hookgres` schema and its tables, or upgrades them. It
is safe to call on every boot and from several processes at once, because it
takes an advisory lock. It runs `CREATE SCHEMA IF NOT EXISTS` each time, and
Postgres checks the `CREATE` privilege even when the schema exists, so the
database user needs `CREATE` on the database and on the schema. If your app's role can only read
and write rows, run `migrate()` from a deploy step with a more privileged role
instead.

## 2. Start a worker

```ts
hookgres.start();
```

This runs a delivery loop in the current process. It checks for due
deliveries every second, and right after each `send()` made from the same
process. On shutdown, call `await hookgres.stop()` to let in-flight requests
finish. See [Running workers](/guides/workers) for other ways to run it,
including from a cron job.

## 3. Register an endpoint

An endpoint is a URL one of your customers wants webhooks sent to. Each
belongs to a tenant: your id for that customer.

```ts
const endpoint = await hookgres.createEndpoint({
  tenantId: "acme",
  url: "https://acme.example.com/webhooks",
  eventTypes: ["invoice.paid", "invoice.refunded"], // omit for every event
});

console.log(endpoint.secret); // whsec_... — show it to your customer once
```

## 4. Send a webhook

```ts
const { message, deliveryCount } = await hookgres.send({
  tenantId: "acme",
  eventType: "invoice.paid",
  payload: { invoiceId: "in_123", amount: 4200 },
});
```

Hookgres queues one delivery for each of the tenant's enabled endpoints that
subscribes to `invoice.paid`, and the worker sends it. The receiver gets a
`POST` with this body:

```json
{
  "type": "invoice.paid",
  "timestamp": "2026-11-08T15:04:05.000Z",
  "data": { "invoiceId": "in_123", "amount": 4200 }
}
```

and three headers: `webhook-id`, `webhook-timestamp` and `webhook-signature`.

## 5. Verify it on the receiving side

Your customers verify the signature with the secret from step 3. They can use
Hookgres's `verifyWebhook` or any [Standard Webhooks](https://www.standardwebhooks.com)
library. Verification needs the **raw** request body, not parsed JSON:

```ts
import express from "express";
import { verifyWebhook } from "hookgres";

const app = express();

app.post("/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = verifyWebhook({
      secret: process.env.WEBHOOK_SECRET!,
      headers: req.headers,
      body: req.body,
    });
    // handle event.type and event.data
    res.sendStatus(204);
  } catch {
    res.sendStatus(400);
  }
});
```

[Verifying webhooks](/guides/verifying) has examples for Next.js, Hono,
Fastify and other languages.

## 6. Look at what happened

Every delivery and attempt is stored:

```ts
const [delivery] = await hookgres.listDeliveries({ messageId: message.id });
console.log(delivery.status); // "succeeded", or "pending" while retrying

for (const attempt of await hookgres.listAttempts(delivery.id)) {
  console.log(attempt.attemptNumber, attempt.statusCode, attempt.durationMs);
}
```

## Next steps

- [Sending webhooks](/guides/sending): transactional sends and idempotency.
- [Going to production](/guides/production): scaling, monitoring, cleanup and
  security.
- The [examples](https://github.com/NickolasBenakis/hookgres/tree/main/examples)
  are small runnable files for each feature.
