# Fixed IPs and data residency

Hookgres runs in your processes and stores everything in your database. So
you decide which IP addresses webhooks come from, and which region the data
lives in. This page shows how to give customers a fixed list of IPs to
allowlist, and how to keep each tenant's webhooks in their region.

## Fixed outbound IPs

Many receivers only accept webhooks from known IP addresses. Hookgres sends
each webhook from the worker process that delivers it, so the source address
is whatever your network gives that process. There are two ways to make it
fixed.

### Run workers behind a NAT gateway or a static egress IP

Put the worker processes in a network whose outbound traffic leaves through
addresses you reserved. No code changes are needed. Some options, from each
provider's docs:

| Platform     | What to use                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS          | A public [NAT gateway](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html) with an Elastic IP, and workers in private subnets |
| Google Cloud | [Cloud NAT](https://docs.cloud.google.com/nat/docs/ports-and-addresses) with manually assigned static (reserved) external IP addresses           |
| Fly.io       | [Static egress IPs](https://docs.fly.io/networking/egress-ips), allocated per app and region with `fly ips allocate-egress`                      |
| Render       | [Dedicated IPs](https://render.com/docs/dedicated-ips), a set of outbound IPs per region (paid, on Pro workspaces and up)                        |
| Railway      | [Static outbound IPs](https://docs.railway.com/reference/static-outbound-ips) per service (Pro plan)                                             |

Only the processes that call `start()`, `runOnce()` or `drain()` send
webhooks. Your web servers can stay where they are; only the workers need the
fixed address. See [Running workers](/guides/workers) for running them as a
separate process.

### Or send through an egress proxy

If your workers can't sit behind a NAT, route webhooks through a forward
proxy that has a fixed address. Pass a `fetch` that uses it. With
[undici](https://undici.nodejs.org/)'s `ProxyAgent`:

```ts
import { Hookgres } from "hookgres";
import { ProxyAgent, type RequestInit, fetch as undiciFetch } from "undici";

const dispatcher = new ProxyAgent(process.env.EGRESS_PROXY_URL!);

const hookgres = new Hookgres({
  pool,
  // undici's types differ slightly from the global fetch types.
  fetch: ((url: string, init: RequestInit) =>
    undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch,
});
```

Hookgres calls your `fetch` with the endpoint URL and
`{ method, headers, body, redirect: "manual", signal }` for every attempt,
then reads the status and the start of the body from the response. Pass
`init` through as above, so redirects stay unfollowed and the request
timeout still applies. Any function that does this works, so you can add
proxy authentication or logging here too. `undici` is a separate package:
install it in your app.

**With `blockPrivateAddresses`.** A custom `fetch` changes how the SSRF guard
works. Hookgres still rejects private and loopback addresses when an
endpoint is created or updated, but it delivers through your `fetch` as is,
and can't check which address the proxy connects to. It emits a
`HOOKGRES_SSRF_CUSTOM_FETCH` warning once, as a reminder. Make the proxy
refuse internal addresses. Stripe's
[Smokescreen](https://github.com/stripe/smokescreen) does both jobs: it
blocks internal addresses and gives you one place to fix the outbound IP.
See [Block internal addresses](/guides/production#block-internal-addresses-ssrf).

### Tell your customers

Publish the addresses in your webhook docs, and say how you'll announce
changes. For example:

> Webhooks come from `203.0.113.10` and `203.0.113.11`. We'll announce
> changes 30 days ahead on this page.

If you run workers in several regions, each region has its own addresses.
List all of them, or tell each customer the ones for their region.

## Data residency

Payloads, endpoints and the delivery log live in your database, in the
schema Hookgres manages. Nothing is stored anywhere else. So the data stays
in the region where that database runs. The [schema
reference](/reference/schema) lists every column, and
[Privacy and GDPR](/guides/privacy) covers what to keep out of payloads.

### One instance per region

If you already keep each tenant's data in a regional database, create one
Hookgres instance per database and pick it by the tenant's region:

```ts
import pg from "pg";
import { Hookgres } from "hookgres";

const hookgres = {
  eu: new Hookgres({
    pool: new pg.Pool({ connectionString: process.env.EU_DATABASE_URL }),
  }),
  us: new Hookgres({
    pool: new pg.Pool({ connectionString: process.env.US_DATABASE_URL }),
  }),
};

type Region = keyof typeof hookgres;

export function webhooksFor(tenant: { region: Region }) {
  return hookgres[tenant.region];
}

// Sending, and managing endpoints, both go through the tenant's region.
await webhooksFor(tenant).createEndpoint({ tenantId: tenant.id, url });
await webhooksFor(tenant).send({
  tenantId: tenant.id,
  eventType: "invoice.paid",
  payload: { invoiceId: "inv_123" },
});
```

Run `migrate()` once against each database. Since each regional database
also holds the tenant's own rows, [transactional
sends](/guides/sending#inside-your-transaction) keep working: pass the
client of the transaction you already opened on that database.

Each instance only knows its own database. An endpoint created through the
EU instance doesn't exist in the US one, so always look up the tenant's
region first.

If a database is shared by several groups of tenants that you keep apart by
schema, give each instance its own `schema` too, as in
`new Hookgres({ pool, schema: "webhooks_acme" })`. A schema doesn't move data
to another region, though; only the database's location decides that.

### Run workers in the same region

Run a worker process in each region, with only that region's instance:

```ts
// worker.ts, deployed in the EU with EU_DATABASE_URL set
const hookgres = new Hookgres({
  pool: new pg.Pool({ connectionString: process.env.EU_DATABASE_URL }),
});
hookgres.start();
process.on("SIGTERM", () => hookgres.stop());
```

The worker reads each payload from the database and sends it, so running it
in the same region keeps payloads from crossing regions on the way out. It
also keeps database round trips short. With fixed IPs, each region then has
its own set of addresses to publish.

A webhook still goes to wherever the receiver runs. Where your customer's
server is, and what it does with the payload, is up to them. Also check
where `onError`, `onAttempt` and your logs send their data, since they can
include tenant ids, endpoint URLs and error messages.
