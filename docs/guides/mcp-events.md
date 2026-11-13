# MCP Events webhooks

MCP Events ([SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415),
extension `io.modelcontextprotocol/events`) lets an MCP server push events to
agents. In webhook mode the client registers a callback URL and a `whsec_`
secret, and the server POSTs each event to it, signed with Standard Webhooks.

`hookgres/mcp-events` is that server side on your Postgres. It answers
`events/list`, `events/subscribe` and `events/unsubscribe`, and `emit()` queues
an event for every matching subscription, inside your transaction if you pass
one.

::: warning Draft specification
SEP-3415 is still under review, and its error codes are provisional. This
module follows the draft as of November 2026 and may change with it.
:::

## Set it up

```ts
import pg from "pg";
import { McpEvents, McpEventsError } from "hookgres/mcp-events";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const events = new McpEvents({
  pool,
  events: [
    {
      name: "incident.created",
      description: "A new incident",
      inputSchema: {
        type: "object",
        properties: { severity: { type: "string" } },
      },
      // Which subscriptions get an event, from their arguments.
      matches: (args, data) =>
        !args.severity || args.severity === data.severity,
    },
  ],
});

await events.migrate(); // its own schema, "hookgres_mcp_events"
events.start(); // delivery worker in this process
```

Add `events.capabilities` to the capabilities your server returns, and route
`events/*` requests to `handle()` with the authenticated principal:

```ts
try {
  return await events.handle(request.method, request.params, {
    principal: auth.subject, // OAuth sub, API key id, ...
  });
} catch (error) {
  if (error instanceof McpEventsError) return { error: error.toJSON() };
  throw error;
}
```

## Emit events

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const incident = await createIncident(client, input);
  await events.emit(
    "incident.created",
    { incidentId: incident.id, severity: incident.severity },
    { client, eventId: incident.id },
  );
  await client.query("COMMIT");
} finally {
  client.release();
}
```

Roll back and nothing is sent. Commit, and the event reaches every live
subscription even if the process restarts before delivery.

## What it does for you

| SEP-3415 requirement                                                             | How                                                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Standard Webhooks signature with the client's secret                             | Each subscription is a Hookgres endpoint with that secret                                             |
| `X-MCP-Subscription-Id` on every POST                                            | Set per attempt; the id is derived from `(principal, url, name, arguments)`                           |
| `webhook-id` unique per message, kept across retries, not derived from `eventId` | Hookgres message ids, one message per subscription                                                    |
| Bounded retries (3-5 attempts within 10-15 minutes)                              | 5 attempts over about 8 minutes by default                                                            |
| `410` and `413` fail that delivery only                                          | `nonRetryableStatuses: [410, 413]`                                                                    |
| `https` only, no private addresses, checked at delivery time, no redirects       | `blockPrivateAddresses` and Hookgres's pinned connections                                             |
| Endpoint verification before the first delivery                                  | A signed `verification` challenge, cached per `(principal, url)`, or your own allowlist with `verify` |
| TTL grant, refresh and secret rotation                                           | `ttl` bounds; a new secret on refresh dual-signs for 5 minutes                                        |
| `deliveryStatus` on refresh                                                      | `active`, `lastDeliveryAt`, `lastError` category, `failedSince`                                       |

## Not covered yet

- Poll and push delivery: they answer `Unsupported`.
- Cursor replay: events are emit-only (`cursor: null`). Hookgres keeps queued
  events across restarts, which is more than the SEP asks of emit-only types.
- `gap` and `terminated` control envelopes.
- `arguments` aren't validated against `inputSchema`; they're only capped at
  4 KB. Validate them before calling `handle()` if your `matches` relies on
  their shape.
- No-expiry subscriptions are only granted with `allowNoExpiry: true`.

Verification POSTs are limited to 10 per destination host per minute
(`verificationsPerHostPerMinute`); over that, subscribe answers
`ResourceExhausted`. Concurrent subscribe and unsubscribe calls for the same
subscription are serialized with a Postgres advisory lock.

Call `events.deleteExpired()` on a schedule to remove expired subscriptions.
