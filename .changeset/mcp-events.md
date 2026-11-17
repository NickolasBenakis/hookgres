---
"hookgres": minor
---

Add `hookgres/mcp-events`: webhook delivery for MCP Events (SEP-3415, draft). It handles `events/list`, `events/subscribe` and `events/unsubscribe`, verifies callback endpoints with a signed challenge, and `emit()` queues an event for every matching subscription inside your transaction, with bounded retries, `X-MCP-Subscription-Id` and Standard Webhooks signatures.
