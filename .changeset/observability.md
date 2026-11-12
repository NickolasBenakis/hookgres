---
"hookgres": minor
---

Add metrics:

- `stats({ tenantId?, endpointId? })` returns the queue right now: `pending`, `due`, `delivering`, `oldestDueAt` and `lagMs`, how long the oldest due delivery has waited. It reads the existing partial indexes: about 20ms with 450,000 pending and in-flight deliveries.
- The `opentelemetry` option takes your `@opentelemetry/api` module (1.7+) and exports `hookgres.delivery.attempts`, `hookgres.delivery.attempt.duration`, `hookgres.endpoints.disabled`, `hookgres.worker.errors`, and the `hookgres.queue.pending`, `.due`, `.delivering` and `.lag` gauges. Attributes are low-cardinality (outcome, status code, `error.type`), with no tenant or endpoint. Hookgres doesn't depend on OpenTelemetry; without the option nothing changes. See the new Metrics and traces guide.
