# Next.js (App Router)

This page adds Hookgres to a Next.js App Router app deployed on Vercel or
another serverless platform: one instance per server process, migrations in
the build, a cron route that delivers webhooks, a transactional send from a
route handler, and endpoint management routes for your customers.

```sh
npm install hookgres pg
```

Hookgres needs Node.js, so use it from route handlers, server actions and
server components on the Node.js runtime (the default), not the Edge runtime
or middleware.

## One instance

Create the pool and the Hookgres instance once, in a server-only module.
In development, Next.js re-evaluates modules on every hot reload, so keep them
on `globalThis` to avoid opening a new pool each time.

```ts
// lib/hookgres.ts
import { Hookgres } from "hookgres";
import pg from "pg";

const globalForHookgres = globalThis as typeof globalThis & {
  hookgresPool?: pg.Pool;
  hookgres?: Hookgres;
};

function createPool() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // A dropped idle connection emits "error" on the pool. Without a listener,
  // it crashes the process. Hookgres only adds one to pools it creates.
  pool.on("error", (error) => console.error("postgres pool error", error));
  return pool;
}

export const pool = (globalForHookgres.hookgresPool ??= createPool());

export const hookgres = (globalForHookgres.hookgres ??= new Hookgres({
  pool,
  blockPrivateAddresses: true, // customers choose the URLs; keep them off your network
  onError: (error) => console.error("hookgres worker error", error),
}));

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

If your app already has a `pg.Pool`, pass that one. Replace `console.error`
with your logger. See [Going to production](/guides/production) for what
`blockPrivateAddresses` checks.

## Run migrations in the build

Serverless functions start often, so don't run `migrate()` on every request.
Run it once per deploy, before `next build`:

```js
// scripts/migrate.mjs
import { Hookgres } from "hookgres";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await new Hookgres({ pool }).migrate();
await pool.end();
```

```json
{
  "scripts": {
    "build": "node scripts/migrate.mjs && next build"
  }
}
```

`migrate()` is idempotent and takes an advisory lock, and it only ever adds to
the schema, so it's safe to run on every deploy. On Vercel, preview
deployments run it too, against whichever database their `DATABASE_URL`
points to. The role needs `CREATE`; see
[Migrations](/guides/production#migrations).

## Deliver from a cron route

Don't call `start()` in Next.js: on serverless platforms the loop stops when
the function is frozen. Instead, a cron job calls a route handler that sends
due deliveries with `drain()` until there are none left or time runs out.

```ts
// app/api/cron/webhooks/route.ts
import { hookgres } from "@/lib/hookgres";

export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  // Returns within 50s: it only starts a batch (up to requestTimeoutMs,
  // 15s) that can finish in time.
  const delivered = await hookgres.drain({ timeoutMs: 50_000 });
  return Response.json({ delivered });
}
```

On Vercel, schedule it in `vercel.json`:

```json
{
  "crons": [{ "path": "/api/cron/webhooks", "schedule": "* * * * *" }]
}
```

Set a `CRON_SECRET` environment variable in the project. Vercel sends it as
`Authorization: Bearer <CRON_SECRET>` on every cron request, and the route
rejects anything else, so no one else can trigger it. Vercel's Hobby plan
only runs crons once a day; per-minute crons need a paid plan. On other
platforms, call the route from any scheduler with the same header.

With a one-minute cron, a webhook can wait up to a minute before it goes
out, and a 5-second retry becomes a 1-minute retry. The next section shows
how to send right away instead. See
[Running workers](/guides/workers#cron-or-serverless) for the trade-offs.

## Send inside a transaction

Queue the webhook in the same transaction as the change it describes. If the
transaction rolls back, no webhook is sent. After the response is sent,
`after()` (Next.js 15.1 or later) runs one `runOnce()` batch, so the webhook
usually goes out within a second instead of waiting for the cron. That batch
claims any due deliveries, not only this one, and can keep the function
running for up to `requestTimeoutMs` (15 seconds) after the response; drop the
line if you'd rather leave all delivery to the cron.

```ts
// app/api/invoices/[id]/pay/route.ts
import { after } from "next/server";
import { getTenantId } from "@/lib/auth";
import { hookgres, transaction } from "@/lib/hookgres";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const tenantId = await getTenantId();
  if (!tenantId) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const invoice = await transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE invoices SET status = 'paid'
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, amount`,
      [id, tenantId],
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
  if (!invoice) return new Response("Not found", { status: 404 });

  after(() => hookgres.runOnce()); // deliver now; the cron retries anything left
  return Response.json({ id: invoice.id, status: "paid" });
}
```

`getTenantId()` stands for your auth: it returns the signed-in user's tenant
from the session, such as their organisation id, or `null`. The
`idempotencyKey` means paying the same invoice twice queues one webhook. If
you use Kysely or Prisma, pass `fromKysely(trx)` from `hookgres/kysely` or
`fromPrisma(tx)` from `hookgres/prisma` as `client`; with another ORM, pass
the transaction's underlying `pg` client. See
[Sending webhooks](/guides/sending#using-an-orm). The same code
works in a server action.

## Endpoint management routes

These routes let a customer manage their own endpoints from your settings
page. Two rules keep tenants apart:

- `tenantId` comes from the session (`getTenantId()`), never from the request
  body or URL.
- Hookgres looks endpoints up by id alone, so every route that takes an id
  loads the endpoint with `getEndpoint()` and checks its `tenantId` first. A
  mismatch answers `404`, the same as a missing endpoint.

The secret is returned once, when the endpoint is created or its secret is
rotated, and never in lists. Two helpers are shared by the routes:

```ts
// lib/endpoints.ts
import type { Endpoint } from "hookgres";
import { hookgres } from "@/lib/hookgres";

/** The endpoint's tenant-facing fields. Leaves out the secret. */
export function view(endpoint: Endpoint) {
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
export async function ownEndpoint(id: string, tenantId: string) {
  const endpoint = await hookgres.getEndpoint(id);
  return endpoint?.tenantId === tenantId ? endpoint : null;
}
```

```ts
// app/api/webhook-endpoints/route.ts
import { type Endpoint, HookgresValidationError } from "hookgres";
import { getTenantId } from "@/lib/auth";
import { view } from "@/lib/endpoints";
import { hookgres } from "@/lib/hookgres";

export async function GET() {
  const tenantId = await getTenantId();
  if (!tenantId) return new Response("Unauthorized", { status: 401 });
  const endpoints = await hookgres.listEndpoints(tenantId);
  return Response.json(endpoints.map(view));
}

export async function POST(request: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return new Response("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => null);
  if (body === null) {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const { url, description, eventTypes } = body;
  let endpoint: Endpoint;
  try {
    endpoint = await hookgres.createEndpoint({
      tenantId,
      url,
      description,
      eventTypes: eventTypes ?? null,
    });
  } catch (error) {
    if (!(error instanceof HookgresValidationError)) throw error;
    return Response.json({ error: error.message }, { status: 400 });
  }
  return Response.json(
    { ...view(endpoint), secret: endpoint.secret },
    { status: 201 },
  );
}
```

```ts
// app/api/webhook-endpoints/[id]/route.ts
import { HookgresValidationError } from "hookgres";
import { getTenantId } from "@/lib/auth";
import { ownEndpoint, view } from "@/lib/endpoints";
import { hookgres } from "@/lib/hookgres";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const tenantId = await getTenantId();
  if (!tenantId) return new Response("Unauthorized", { status: 401 });
  const endpoint = await ownEndpoint((await params).id, tenantId);
  if (!endpoint) return new Response("Not found", { status: 404 });
  const body = await request.json().catch(() => null);
  if (body === null) {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const { url, description, eventTypes, disabled } = body;
  try {
    const updated = await hookgres.updateEndpoint(endpoint.id, {
      url,
      description,
      eventTypes,
      disabled,
    });
    return Response.json(updated && view(updated));
  } catch (error) {
    if (!(error instanceof HookgresValidationError)) throw error;
    return Response.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  const tenantId = await getTenantId();
  if (!tenantId) return new Response("Unauthorized", { status: 401 });
  const endpoint = await ownEndpoint((await params).id, tenantId);
  if (!endpoint) return new Response("Not found", { status: 404 });
  await hookgres.deleteEndpoint(endpoint.id);
  return new Response(null, { status: 204 });
}
```

```ts
// app/api/webhook-endpoints/[id]/rotate-secret/route.ts
import { getTenantId } from "@/lib/auth";
import { ownEndpoint } from "@/lib/endpoints";
import { hookgres } from "@/lib/hookgres";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const tenantId = await getTenantId();
  if (!tenantId) return new Response("Unauthorized", { status: 401 });
  const endpoint = await ownEndpoint((await params).id, tenantId);
  if (!endpoint) return new Response("Not found", { status: 404 });
  const rotated = await hookgres.rotateEndpointSecret(endpoint.id);
  return Response.json({ secret: rotated?.secret });
}
```

`createEndpoint()` and `updateEndpoint()` throw for an invalid or blocked URL
and for an invalid `eventTypes` array with a `HookgresValidationError`, which
these routes return as `400` with its message. A body that isn't JSON is a
`400` too. Any other error, such as a database error, is rethrown and becomes
a `500`.
Validate the body with your usual schema library, such as zod, before it gets
here. Only the fields you pass to `updateEndpoint()` change; `undefined` ones
are left alone. After a rotation, Hookgres signs with both the old and new
secret for 24 hours; see [Secret rotation](/guides/secret-rotation).

## Receiving webhooks

If your app also receives webhooks, or you want to test your own, verify the
raw body from `request.text()` with `verifyWebhook()` in a route handler. See
[Verifying webhooks](/guides/verifying#next-js-app-router).
