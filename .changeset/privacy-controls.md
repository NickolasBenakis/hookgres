---
"hookgres": minor
---

Add privacy controls for GDPR:

- `redactPayloads` (default `false`) clears a message's payload once every delivery of it has succeeded, or right away when no endpoint matched, and keeps the delivery log. `Message` gets `redactedAt`, and `payload` is `null` once redacted. Payloads of failed deliveries are kept for replay; replaying a redacted delivery throws a `HookgresValidationError`. `migrate()` makes `messages.payload` nullable and adds `messages.redacted_at` (catalog-only changes, no table rewrite).
- `responseBodyLimit` (default and maximum 4096) sets how many characters of each receiver response the attempt log stores; `0` stores none.
- `deleteMessages({ tenantId, messageIds, payloadContains })` deletes matching messages with their deliveries and attempts, whatever their status, for erasure requests and offboarding. At least one filter is required.
- New docs page: Privacy and GDPR.
