# Hono

This page adds Hookgres to a Hono app served by `@hono/node-server` as a
long-running Node process: one instance for the app, migrations on boot, a
worker in the same process, a transactional send from a route, and endpoint
management routes for your customers.

```sh
npm install hookgres pg hono @hono/node-server
```

Hookgres needs Node.js and a TCP connection to Postgres, so it doesn't run on
Cloudflare Workers or other edge runtimes. On a serverless platform, call
`drain()` from a scheduled function instead of `start()`; see
[Running workers](/guides/workers#cron-or-serverless).

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

The routes below read the tenant from a context variable that your auth
middleware sets from the signed-in session, so they share one `Env` type:

```ts
// src/env.ts
export type Env = {
  Variables: {
    /** Set by your auth middleware from the session, e.g. the user's organisation id. */
    tenantId: string;
  };
};
```

## Migrate, start the worker, shut down

Run `migrate()` before the server listens, then `start()` the worker. On
`SIGTERM`, stop taking HTTP requests, let in-flight webhook requests finish
with `stop()`, and only then end the pool.

```ts
// src/server.ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { requireTenant } from "./auth.js";
import type { Env } from "./env.js";
import { hookgres, pool } from "./hookgres.js";
import { endpoints } from "./routes/endpoints.js";
import { invoices } from "./routes/invoices.js";

await hookgres.migrate();

const app = new Hono<Env>();
app.use("/api/*", requireTenant);
app.route("/api", invoices);
app.route("/api", endpoints);

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});
hookgres.start();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; // e.g. SIGINT while a SIGTERM shutdown runs
  shuttingDown = true;
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
`migrate()` and `start()` without `serve()`, with the same shutdown handler.
See [Running workers](/guides/workers).

`requireTenant` stands for your existing auth middleware. It should call
`c.set("tenantId", ...)` with the signed-in user's tenant and answer `401`
when there is no session.

## Send inside a transaction

Queue the webhook in the same transaction as the change it describes. If the
transaction rolls back, no webhook is sent.

```ts
// src/routes/invoices.ts
import { Hono } from "hono";
import type { Env } from "../env.js";
import { hookgres, transaction } from "../hookgres.js";

export const invoices = new Hono<Env>();

invoices.post("/invoices/:id/pay", async (c) => {
  const tenantId = c.get("tenantId");
  const invoice = await transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE invoices SET status = 'paid'
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, amount`,
      [c.req.param("id"), tenantId],
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
  if (!invoice) return c.notFound();
  return c.json({ id: invoice.id, status: "paid" });
});
```

The `idempotencyKey` means paying the same invoice twice queues one webhook.
With Kysely or Prisma, pass `fromKysely(trx)` from `hookgres/kysely` or
`fromPrisma(tx)` from `hookgres/prisma` as `client`; with another ORM, pass
the transaction's underlying `pg` client. See
[Sending webhooks](/guides/sending#using-an-orm).

## Endpoint management routes

These routes let a customer manage their own endpoints from your settings
page. Two rules keep tenants apart:

- `tenantId` comes from the session (`c.get("tenantId")`), never from the
  request body or URL.
- Hookgres looks endpoints up by id alone, so every route that takes an id
  loads the endpoint with `getEndpoint()` and checks its `tenantId` first. A
  mismatch answers `404`, the same as a missing endpoint.

The secret is returned once, when the endpoint is created or its secret is
rotated, and never in lists.

```ts
// src/routes/endpoints.ts
import { Hono } from "hono";
import { type Endpoint, HookgresValidationError } from "hookgres";
import type { Env } from "../env.js";
import { hookgres } from "../hookgres.js";

export const endpoints = new Hono<Env>();

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

endpoints.get("/webhook-endpoints", async (c) => {
  const list = await hookgres.listEndpoints(c.get("tenantId"));
  return c.json(list.map(view));
});

endpoints.post("/webhook-endpoints", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) return c.json({ error: "Body must be JSON" }, 400);
  const { url, description, eventTypes } = body;
  let endpoint: Endpoint;
  try {
    endpoint = await hookgres.createEndpoint({
      tenantId: c.get("tenantId"),
      url,
      description,
      eventTypes: eventTypes ?? null,
    });
  } catch (error) {
    if (!(error instanceof HookgresValidationError)) throw error;
    return c.json({ error: error.message }, 400);
  }
  return c.json({ ...view(endpoint), secret: endpoint.secret }, 201);
});

endpoints.patch("/webhook-endpoints/:id", async (c) => {
  const endpoint = await ownEndpoint(c.req.param("id"), c.get("tenantId"));
  if (!endpoint) return c.notFound();
  const body = await c.req.json().catch(() => null);
  if (body === null) return c.json({ error: "Body must be JSON" }, 400);
  const { url, description, eventTypes, disabled } = body;
  try {
    const updated = await hookgres.updateEndpoint(endpoint.id, {
      url,
      description,
      eventTypes,
      disabled,
    });
    return c.json(updated && view(updated));
  } catch (error) {
    if (!(error instanceof HookgresValidationError)) throw error;
    return c.json({ error: error.message }, 400);
  }
});

endpoints.delete("/webhook-endpoints/:id", async (c) => {
  const endpoint = await ownEndpoint(c.req.param("id"), c.get("tenantId"));
  if (!endpoint) return c.notFound();
  await hookgres.deleteEndpoint(endpoint.id);
  return c.body(null, 204);
});

endpoints.post("/webhook-endpoints/:id/rotate-secret", async (c) => {
  const endpoint = await ownEndpoint(c.req.param("id"), c.get("tenantId"));
  if (!endpoint) return c.notFound();
  const rotated = await hookgres.rotateEndpointSecret(endpoint.id);
  return c.json({ secret: rotated?.secret });
});
```

`createEndpoint()` and `updateEndpoint()` throw for an invalid or blocked URL
and for an invalid `eventTypes` array with a `HookgresValidationError`, which
these routes return as `400` with its message. A body that isn't JSON is a
`400` too. Any other error, such as a database error, is rethrown and becomes
a `500`.
Validate the body with your usual schema library, such as
`@hono/zod-validator`, before it gets here. Only the fields you pass to
`updateEndpoint()` change; `undefined` ones are left alone. After a rotation,
Hookgres signs with both the old and new secret for 24 hours; see
[Secret rotation](/guides/secret-rotation).

## Receiving webhooks

If your app also receives webhooks, or you want to test your own, verify the
raw body from `c.req.text()` with `verifyWebhook()`. See
[Verifying webhooks](/guides/verifying#hono).
