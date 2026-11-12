---
"hookgres": minor
---

Add OpenTelemetry traces. With the `opentelemetry` option, `send()` records a `send webhook` producer span under your request's span, and each HTTP attempt records a `deliver webhook` client span linked back to it, so you can get from a request to every attempt at delivering its webhooks. Endpoint URLs (which often carry secrets), baggage and `traceparent` headers to customers are left out on purpose. Webhook requests are sent with tracing suppressed, so HTTP instrumentations (undici, `node:http`) don't record their URLs or add `traceparent` and baggage headers to them, even with `traces: false` (as long as `api` includes `context`). Set `httpInstrumentation: true` to let them trace webhook requests anyway. Migration 5 adds a nullable `messages.trace_context` column; it's only read and written when traces are on. Set `traces: false` for metrics only.
