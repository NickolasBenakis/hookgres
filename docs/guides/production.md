# Going to production

Before you launch, make sure you:

1. Run `migrate()` once per deploy, before the new code serves traffic.
2. Run at least one worker, and stop it gracefully on shutdown.
3. Block endpoints from reaching your internal network.
4. Send `onError` to your logger.
5. Monitor the backlog and failing endpoints.
6. Delete old rows on a schedule.
7. Tell receivers to deduplicate on `webhook-id`.

## Migrations

`migrate()` creates or upgrades Hookgres's tables. It takes an advisory lock,
so calling it from every instance at boot is safe, as long as the app's
database role has `CREATE` on the database and on the Hookgres schema.
Postgres checks that privilege even when nothing needs creating. If your app
runs with a role that can only read and write rows, run `migrate()` from a
deploy step with a more privileged role, and grant the app role `USAGE` on the
schema plus `SELECT, INSERT, UPDATE, DELETE` on its tables.
Migrations only ever add to the schema. Upgrading Hookgres never requires you
to edit the tables yourself.

All tables live in one schema (`hookgres` by default, or the `schema`
option), so they stay out of the way of your own migrations tool. Most tools
only manage the `public` schema, but check that yours won't try to drop
tables it doesn't know about.

## Workers

See [Running workers](/guides/workers). In short: call `start()` in one or more
long-running processes, call `await hookgres.stop()` on `SIGTERM`, or use
`runOnce()` from a cron job on serverless platforms.

## Block internal addresses (SSRF)

Your customers choose the URLs Hookgres sends requests to. Without a guard,
someone could register `http://169.254.169.254/` (your cloud's metadata
service) or `http://10.0.0.5:6379/` and make your servers send requests
inside your network. This is called server-side request forgery (SSRF).
Hookgres doesn't follow redirects and doesn't show response bodies to
endpoint owners unless you build that, but you should still block it.

You have two options.

**An egress proxy.** Send all webhook traffic through a proxy that only
allows public addresses, such as Stripe's
[Smokescreen](https://github.com/stripe/smokescreen). This is the most
robust option and also gives you fixed outbound IPs that customers can
allowlist.

**A guarded `fetch`.** Pass a `fetch` that refuses internal addresses. This
version checks the address actually connected to, after DNS, so a hostname
that resolves to an internal IP is caught too. It uses the
[`undici`](https://github.com/nodejs/undici) package (`npm install undici`):

```ts
import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

const isBlocked = (address: string) =>
  blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");

const agent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, []);
        const bad = addresses.find((a) => isBlocked(a.address));
        if (bad) {
          return callback(
            new Error(`Blocked internal address ${bad.address}`),
            [],
          );
        }
        if (options.all) return callback(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      });
    },
  },
});

const safeFetch = ((url: string | URL, init?: RequestInit) => {
  // URLs with an IP address skip DNS, so check those here.
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlocked(host)) {
    return Promise.reject(new Error(`Blocked internal address ${host}`));
  }
  return undiciFetch(url, { ...init, dispatcher: agent } as never);
}) as unknown as typeof fetch;

const hookgres = new Hookgres({ pool, fetch: safeFetch });
```

Blocked attempts fail like any other network error, with
`Blocked internal address ...` in the attempt's error (prefixed with
`fetch failed: ` when the address came from DNS). Add any other
ranges your network uses. It's also worth validating URLs when customers
create endpoints, so they get an error straight away.

## Monitoring

Hookgres's state is plain tables, so monitoring is a few SQL queries. Adjust
the schema name if you changed it.

**Backlog**: deliveries that are due but not yet sent. This should stay near
zero. If it grows, add workers or raise `concurrency`.

```sql
SELECT count(*) AS due, min(next_attempt_at) AS oldest
FROM hookgres.deliveries
WHERE status = 'pending' AND next_attempt_at <= now();
```

**Failing endpoints**: worth emailing the tenant before Hookgres disables the
endpoint.

```sql
SELECT id, tenant_id, url, failing_since
FROM hookgres.endpoints
WHERE failing_since IS NOT NULL AND NOT disabled
ORDER BY failing_since;
```

**Outcomes in the last hour**:

```sql
SELECT status, count(*)
FROM hookgres.deliveries
WHERE updated_at > now() - interval '1 hour'
GROUP BY status;
```

**Disabled endpoints changed in the last day** (there's no separate
"disabled at" column, so this also lists older disabled endpoints that were
updated since):

```sql
SELECT id, tenant_id, url, disabled_reason
FROM hookgres.endpoints
WHERE disabled AND updated_at > now() - interval '1 day';
```

## Clean up old rows

Hookgres keeps every message, delivery and attempt until you delete them. Pick
a retention period and run a cleanup job, for example daily. Deleting a
message also deletes its deliveries and attempts. This query skips messages
that still have deliveries in progress:

```sql
DELETE FROM hookgres.messages m
WHERE m.created_at < now() - interval '30 days'
  AND NOT EXISTS (
    SELECT 1 FROM hookgres.deliveries d
    WHERE d.message_id = m.id AND d.status IN ('pending', 'delivering')
  );
```

On large tables, delete in batches (for example `AND m.id IN (SELECT id ...
LIMIT 10000)` in a loop) to keep transactions short. Remember that deleting a
message frees its idempotency key.

## Database load

Each `send()` is one `INSERT` statement. Each delivery attempt is two short
queries: a claim and a result. Workers hold no connection while waiting for
an HTTP response. On a laptop, Hookgres handled about 13,000 `send()` calls
and 5,500 deliveries per second (see `pnpm bench` in the repository), so for
most apps webhooks are a small fraction of database load.

Webhooks share your database's disk and connections. If you send very large
volumes, keep an eye on table size (see cleanup) and the connection pool.

## Security checklist

- Treat endpoint secrets like passwords. Only return them to the tenant that
  owns the endpoint.
- Check tenant ownership before reading, updating or deleting an endpoint,
  since Hookgres looks endpoints up by id alone.
- Block internal addresses, as described above.
- Don't put secrets or personal data in payloads that receivers don't need.
