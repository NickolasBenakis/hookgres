# Going to production

Before you launch, make sure you:

1. Run `migrate()` once per deploy, before the new code serves traffic.
2. Run at least one worker, and stop it gracefully on shutdown.
3. Block endpoints from reaching your internal network
   (`blockPrivateAddresses`).
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

Turn on `blockPrivateAddresses`:

```ts
const hookgres = new Hookgres({ pool, blockPrivateAddresses: true });
```

If some internal receivers are legitimate, list them. Everything else stays
blocked. Entries are IPv4 or IPv6 addresses or CIDR ranges:

```ts
const hookgres = new Hookgres({
  pool,
  blockPrivateAddresses: { allow: ["10.1.2.0/24", "fd00::5"] },
});
```

It's off by default. With it on, Hookgres checks twice:

- **When an endpoint is created or updated.** `createEndpoint` and
  `updateEndpoint` throw if the URL's host is a blocked IP address, or
  `localhost` or a name ending in `.localhost`. The host is read the way
  `new URL()` reads it, so `http://2130706433/`, `http://0x7f.1/` and
  `http://[::ffff:127.0.0.1]/` are all caught as `127.0.0.1`. There's no DNS
  lookup at this point, so customers get an error straight away for the
  obvious cases. `localhost` names are rejected even if `allow` covers
  loopback; use the IP address, like `http://127.0.0.1:3000/`. Ports that
  `fetch` refuses, such as 25 (SMTP) and 6667 (IRC), are rejected too.
- **On every delivery.** Hookgres resolves the hostname, gets every address
  it points to, and refuses to send if any of them is blocked. The
  connection then goes to one of the addresses it just checked, so a DNS
  record that changes between the check and the connection (DNS rebinding)
  can't slip through. Endpoints created before you turned the option on
  are checked here too.

Blocked addresses are the private, loopback, link-local, carrier-grade NAT,
multicast, documentation and reserved ranges, for IPv4 and IPv6. IPv6
addresses that carry an IPv4 address inside them (`::ffff:127.0.0.1`,
`::127.0.0.1`, NAT64 `64:ff9b::7f00:1`, 6to4 `2002:7f00:1::`) are judged by
that IPv4 address, and only IPv4 `allow` entries apply to them. A blocked
attempt fails like a network error, with
`Blocked private address 10.0.0.5` as its error, and is retried on the normal
schedule. If the DNS record later points somewhere public, the next attempt
goes through.

With the option on, Hookgres sends requests with Node's `http` and `https`
modules instead of `fetch`, so it can control which address it connects to.
Receivers get the same method, headers and body, plus `accept: */*` and
`accept-encoding: identity`, so responses come back uncompressed. URLs with
a username or password fail, as they do with `fetch`. Error messages use
Node's wording, like `connect ECONNREFUSED 203.0.113.7:443` instead of
`fetch failed: ECONNREFUSED`.

Node's built-in proxy support (`NODE_USE_ENV_PROXY` together with
`HTTP_PROXY` or `HTTPS_PROXY`) is ignored while the option is on, because
going through the proxy would hide which address the request reaches.
Hookgres connects directly and emits a `HOOKGRES_SSRF_ENV_PROXY` warning
once, when you create the instance. If webhooks must go through a proxy,
pass a `fetch` that uses it.

**With your own `fetch`**, for example one that sends through a proxy,
Hookgres still checks endpoint URLs when they're created or updated, but
delivers through your `fetch` as is. It can't see which address your
transport connects to, so checking that is the job of the transport or the
proxy, such as Smokescreen. Hookgres emits a `HOOKGRES_SSRF_CUSTOM_FETCH`
warning once, when you create the instance, as a reminder.
`isPrivateAddress(ip)`, exported from `hookgres`, applies the same rules as
the built-in guard. Call it on every address your transport's DNS lookup
returns, and on hosts that are already IP addresses (it accepts
`new URL(url).hostname` as is, brackets included).

**Also block it at the network level.** An egress proxy that only allows
public addresses, such as Stripe's
[Smokescreen](https://github.com/stripe/smokescreen), or firewall rules on
the worker hosts, protect you even if application code has a gap. Some
cloud-internal services sit on public IPs, like Azure's `168.63.129.16`,
so an address-based guard alone can't catch them. A proxy also gives you
fixed outbound IPs that customers can allowlist.

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
