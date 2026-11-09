# Express

This page adds Hookgres to an Express 5 app that runs as a long-running Node
process: one instance for the app, migrations on boot, a worker in the same
process, a transactional send from a route, and endpoint management routes for
your customers.

```sh
npm install hookgres pg express
```

## One instance

Create the pool and the Hookgres instance once, in their own module, and
import them everywhere else. If your app already has a `pg.Pool`, pass that one.

```ts
// src/hookgres.ts
import { Hookgres } from "hookgres";
import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// A dropped idle connection emits "error" on the pool. Without a listener,
// it crashes the process. Hookgres only adds one to pools it creates.
pool.on("error", (error) => console.error("postgres pool error", error));

export const hookgres = new Hookgres({
  pool,
  blockPrivateAddresses: true, // customers choose the URLs; keep them off your network
  onError: (error) => console.error("hookgres worker error", error),
});

/** Runs `fn` in a transaction and commits only if it doesn't throw. */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {}); // keep the original error
    throw error;
  } finally {
    client.release();
  }
}
```

Replace `console.error` with your logger. See
[Going to production](/guides/production) for what `blockPrivateAddresses`
checks.

## Migrate, start the worker, shut down

Run `migrate()` before the server listens, then `start()` the worker. On
`SIGTERM`, stop taking HTTP requests, let in-flight webhook requests finish
with `stop()`, and only then end the pool.

```ts
// src/server.ts
import express from "express";
import { requireTenant } from "./auth.js";
import { hookgres, pool } from "./hookgres.js";
import { endpoints } from "./routes/endpoints.js";
import { invoices } from "./routes/invoices.js";

await hookgres.migrate();

const app = express();
app.use(express.json());
app.use("/api", requireTenant, invoices, endpoints);

const server = app.listen(Number(process.env.PORT ?? 3000));
hookgres.start();

async function shutdown() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await hookgres.stop();
  await pool.end();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
```

`migrate()` is idempotent and takes an advisory lock, so every instance can
run it on boot. If the app's database role can't `CREATE`, run it from a
deploy step instead; see [Migrations](/guides/production#migrations).

The worker can also run in a separate process: a second entry point that calls
`migrate()` and `start()` without `app.listen()`, with the same shutdown
handler. See [Running workers](/guides/workers).

`requireTenant` stands for your existing auth middleware. The routes below
expect it to set `res.locals.tenantId` from the signed-in session, for example
the user's organisation id, and to answer `401` when there is no session.

## Send inside a transaction

Queue the webhook in the same transaction as the change it describes. If the
transaction rolls back, no webhook is sent.

```ts
// src/routes/invoices.ts
import { Router } from "express";
import { hookgres, transaction } from "../hookgres.js";

export const invoices = Router();

invoices.post("/invoices/:id/pay", async (req, res) => {
  const tenantId: string = res.locals.tenantId;
  const invoice = await transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE invoices SET status = 'paid'
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, amount`,
      [req.params.id, tenantId],
    );
    const invoice = rows[0];
    if (!invoice) return null;
    await hookgres.send(
      {
        tenantId,
        eventType: "invoice.paid",
        payload: { invoiceId: invoice.id, amount: invoice.amount },
        idempotencyKey: `invoice.paid:${invoice.id}`,
      },
      { client },
    );
    return invoice;
  });
  if (!invoice) {
    res.sendStatus(404);
    return;
  }
  res.json({ id: invoice.id, status: "paid" });
});
```

The `idempotencyKey` means paying the same invoice twice queues one webhook.
If you use an ORM, pass the transaction's underlying `pg` client; see
[Sending webhooks](/guides/sending#inside-your-transaction).

## Endpoint management routes

These routes let a customer manage their own endpoints from your settings
page. Two rules keep tenants apart:

- `tenantId` comes from the session (`res.locals.tenantId`), never from the
  request body or URL.
- Hookgres looks endpoints up by id alone, so every route that takes an id
  loads the endpoint with `getEndpoint()` and checks its `tenantId` first. A
  mismatch answers `404`, the same as a missing endpoint.

The secret is returned once, when the endpoint is created or its secret is
rotated, and never in lists.

```ts
// src/routes/endpoints.ts
import { Router } from "express";
import type { Endpoint } from "hookgres";
import { hookgres } from "../hookgres.js";

export const endpoints = Router();

/** The endpoint's tenant-facing fields. Leaves out the secret. */
function view(endpoint: Endpoint) {
  return {
    id: endpoint.id,
    url: endpoint.url,
    description: endpoint.description,
    eventTypes: endpoint.eventTypes,
    disabled: endpoint.disabled,
    disabledReason: endpoint.disabledReason,
    createdAt: endpoint.createdAt,
  };
}

/** The endpoint if it belongs to the tenant, otherwise null. */
async function ownEndpoint(id: string, tenantId: string) {
  const endpoint = await hookgres.getEndpoint(id);
  return endpoint?.tenantId === tenantId ? endpoint : null;
}

endpoints.get("/webhook-endpoints", async (_req, res) => {
  const list = await hookgres.listEndpoints(res.locals.tenantId);
  res.json(list.map(view));
});

endpoints.post("/webhook-endpoints", async (req, res) => {
  const { url, description, eventTypes } = req.body ?? {};
  let endpoint: Endpoint;
  try {
    endpoint = await hookgres.createEndpoint({
      tenantId: res.locals.tenantId,
      url,
      description,
      eventTypes: eventTypes ?? null,
    });
  } catch (error) {
    // Validation errors are plain Errors; database errors carry a `code`.
    if (!(error instanceof Error) || "code" in error) throw error;
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(201).json({ ...view(endpoint), secret: endpoint.secret });
});

endpoints.patch("/webhook-endpoints/:id", async (req, res) => {
  const endpoint = await ownEndpoint(req.params.id, res.locals.tenantId);
  if (!endpoint) {
    res.sendStatus(404);
    return;
  }
  const { url, description, eventTypes, disabled } = req.body ?? {};
  try {
    const updated = await hookgres.updateEndpoint(endpoint.id, {
      url,
      description,
      eventTypes,
      disabled,
    });
    res.json(updated && view(updated));
  } catch (error) {
    // Validation errors are plain Errors; database errors carry a `code`.
    if (!(error instanceof Error) || "code" in error) throw error;
    res.status(400).json({ error: error.message });
  }
});

endpoints.delete("/webhook-endpoints/:id", async (req, res) => {
  const endpoint = await ownEndpoint(req.params.id, res.locals.tenantId);
  if (!endpoint) {
    res.sendStatus(404);
    return;
  }
  await hookgres.deleteEndpoint(endpoint.id);
  res.sendStatus(204);
});

endpoints.post("/webhook-endpoints/:id/rotate-secret", async (req, res) => {
  const endpoint = await ownEndpoint(req.params.id, res.locals.tenantId);
  if (!endpoint) {
    res.sendStatus(404);
    return;
  }
  const rotated = await hookgres.rotateEndpointSecret(endpoint.id);
  res.json({ secret: rotated?.secret });
});
```

`createEndpoint()` and `updateEndpoint()` throw for an invalid or blocked URL
and for an empty `eventTypes` array, which these routes return as `400` with the message. Database errors, which carry a `code`, are rethrown and become `500`s.
Validate the body with your usual schema library before it gets here. Only the
fields you pass to `updateEndpoint()` change; `undefined` ones are left alone.
After a rotation, Hookgres signs with both the old and new secret for 24 hours;
see [Secret rotation](/guides/secret-rotation).

## Receiving webhooks

If your app also receives webhooks, or you want to test your own, verify them
with `express.raw()` and `verifyWebhook()`. See
[Verifying webhooks](/guides/verifying#express).
