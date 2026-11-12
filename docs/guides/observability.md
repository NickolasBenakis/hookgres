# Metrics, traces and monitoring

Two questions matter for webhooks in production: are they going out, and how
far behind are they? `stats()` answers both from the database at any time.
The `opentelemetry` option exports the same numbers, plus per-attempt
metrics and traces, to whatever OpenTelemetry backend you use.

## Read the queue with `stats()`

```ts
const stats = await hookgres.stats();
// { pending: 12, due: 3, delivering: 4, oldestDueAt: Date, lagMs: 850 }
```

| Field         | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `pending`     | Deliveries waiting, including retries scheduled for later.                                           |
| `due`         | Pending deliveries whose time has come: what workers should be sending right now.                    |
| `delivering`  | Deliveries a worker has claimed, including ones whose worker died and whose lock hasn't expired yet. |
| `oldestDueAt` | When the oldest due delivery became due, or `null` if nothing is due.                                |
| `lagMs`       | How long that delivery has waited, by the database clock. `0` when nothing is due.                   |

**Alert on `lagMs`.** With healthy workers it stays under a second or two. It
grows when workers are down, too few for the load, or stuck behind slow
endpoints. `pending` alone isn't a good alarm: a failing customer endpoint
keeps deliveries pending for hours on purpose, waiting for retries.

Pass `tenantId` or `endpointId` to see one customer's queue, for a support
page or to find the endpoint everyone is waiting behind:

```ts
await hookgres.stats({ tenantId: "acme" });
await hookgres.stats({ endpointId: "ep_..." });
```

`stats()` counts every pending and delivering row through their indexes:
about 20ms with 450,000 of them. Calling it every few seconds from a health
check is fine; calling it on every request isn't.

## OpenTelemetry

Pass your app's `@opentelemetry/api` module and Hookgres records metrics and
traces through whatever SDK and exporter you configured. Hookgres doesn't depend on
OpenTelemetry; without this option it records nothing.

```ts
import * as otel from "@opentelemetry/api";
import { Hookgres } from "hookgres";

const hookgres = new Hookgres({
  pool,
  opentelemetry: { api: otel },
});
```

Requires `@opentelemetry/api` 1.7 or later, and an SDK set up before this
runs, as for any instrumented library.

### Metrics

| Name                                 | Type      | Unit         | Attributes                                                    |
| ------------------------------------ | --------- | ------------ | ------------------------------------------------------------- |
| `hookgres.delivery.attempts`         | Counter   | `{attempt}`  | `hookgres.outcome`, `http.response.status_code`, `error.type` |
| `hookgres.delivery.attempt.duration` | Histogram | `s`          | same                                                          |
| `hookgres.endpoints.disabled`        | Counter   | `{endpoint}` | —                                                             |
| `hookgres.worker.errors`             | Counter   | `{error}`    | `error.type`                                                  |
| `hookgres.queue.pending`             | Gauge     | `{delivery}` | —                                                             |
| `hookgres.queue.due`                 | Gauge     | `{delivery}` | —                                                             |
| `hookgres.queue.delivering`          | Gauge     | `{delivery}` | —                                                             |
| `hookgres.queue.lag`                 | Gauge     | `s`          | —                                                             |

- `hookgres.outcome` is `succeeded`, `retrying` or `failed`, as in
  `onAttempt`.
- `http.response.status_code` is set when the receiver responded.
- `error.type` is set on unsuccessful attempts: the status code (`"500"`),
  `timeout`, `blocked_address` (an address or port `blockPrivateAddresses`
  refused), or `_OTHER` for network and other errors without a response. On
  `hookgres.worker.errors` it's the error's `code`, such as a Postgres error
  code (`"57P01"`) or a Node one (`"ECONNREFUSED"`), or else its name. A
  failed queue-gauge query counts there too.
- If your meter throws, Hookgres drops the measurement and carries on:
  metrics never get in the way of delivery.

There are no tenant, endpoint or event type attributes: each distinct value
is a separate time series, and with many customers that gets expensive fast.
For per-customer numbers, use `stats({ tenantId })` or the `onAttempt` hook.

### Queue gauges

The `hookgres.queue.*` gauges come from `stats()`, run once per metric export
(every 60 seconds by default). Every process that sets the option reports
them, and they all report the same values, so in dashboards take the **max**
across processes, not the sum. To read them from one place only, set
`queueMetrics: false` on the others, for example on web processes:

```ts
new Hookgres({ pool, opentelemetry: { api: otel, queueMetrics: false } });
```

If the query fails, the export goes on without the gauges and the error goes
to `onError`.

### Suggested alerts

- `hookgres.queue.lag` above a minute: workers are down or can't keep up.
- `hookgres.worker.errors` rising: the database is unreachable or overloaded.
- The share of `hookgres.delivery.attempts` with `hookgres.outcome="failed"`
  jumping: many endpoints failing at once usually means a problem on your
  side, like a broken payload or an egress outage, not your customers'.

## Traces

With the same option, Hookgres also records spans, so you can follow a
webhook from the request that caused it to every attempt to deliver it:

- **`send webhook`** (producer), a child of whatever span is active when you
  call `send()`, usually your HTTP request's. Hookgres stores its trace
  context with the message.
- **`deliver webhook`** (client), one per HTTP attempt, **linked** to the
  `send webhook` span. Each attempt starts its own trace instead of joining
  the request's: retries can run for a day, and a day-long trace confuses
  most tracing backends. Follow the link to get from one to the other.

The attempt span is active during the request, so if you also use an HTTP
instrumentation, its span nests under it. Attributes:

| Span              | Attributes                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send webhook`    | `messaging.system`, `messaging.operation.type` (`send`), `messaging.message.id`, `hookgres.tenant_id`, `hookgres.event_type`, `hookgres.delivery_count`, `hookgres.deduplicated`                                                                                |
| `deliver webhook` | `messaging.message.id`, `hookgres.delivery.id`, `hookgres.endpoint.id`, `hookgres.tenant_id`, `hookgres.event_type`, `hookgres.attempt_number`, `http.request.method`, `http.response.status_code`, `server.address`, `server.port`, `url.scheme`, `error.type` |

Span attributes can be specific (ids, tenants): traces are sampled and
stored per request, not aggregated into series like metrics.

What Hookgres leaves out on purpose:

- **The endpoint URL.** Many webhook URLs carry a secret in the path or
  query, so only the host, port and scheme are recorded.
- **`traceparent` on the webhook request.** Your trace ids would go to every
  customer. If an HTTP instrumentation adds one anyway, that's its setting.
- **Baggage.** It's application data, possibly personal, so it isn't stored
  with the message. Only the trace context is (`traceparent`, `tracestate`,
  or your propagator's equivalent), and only if under 1 KB.

Traces need the full `@opentelemetry/api` module (`trace`, `context` and
`propagation`), which is what you pass anyway. To record metrics only, set
`traces: false`. Storing the trace context needs migration 5
(`messages.trace_context`), which `migrate()` adds; run it before turning
traces on. Messages queued before then are delivered with unlinked spans.

## Hooks

For anything the built-in metrics don't cover, such as per-tenant numbers
for a few large customers, or a log line per failure, use the hooks
described in [Metrics and tracing](/guides/production#metrics-and-tracing).
They run alongside the `opentelemetry` option.
