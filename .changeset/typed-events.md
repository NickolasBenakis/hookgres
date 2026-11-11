---
"hookgres": minor
---

Add typed events. Pass one [Standard Schema](https://standardschema.dev) per event type, such as a Zod (3.24+ or 4), Valibot or ArkType schema, as `new Hookgres({ pool, schemas })`, and `send()` is typed from them: a misspelled event type or a payload that doesn't match fails to compile. At runtime, `send()` validates each payload before writing and stores the schema's output, so undeclared keys are dropped and transforms are applied. An invalid payload, or an event type with no schema, throws a `HookgresValidationError` with the schema's `issues`, and nothing is queued. With `schemas`, `createEndpoint()` and `updateEndpoint()` also reject `eventTypes` that match no declared event type. For compile-time checks only, use `new Hookgres<Events>({ pool })` with an event map. Hookgres still has no runtime dependencies besides `pg`.

New types: `EventMap`, `AnyEvents`, `EventSchemas`, `EventTypeFilter`, `InferEvents`, `WebhookEvent` (a union of envelopes to narrow on `type` after `verifyWebhook`) and `StandardSchemaV1`. `SendInput`, `CreateEndpointInput` and `UpdateEndpointInput` take an optional event map; without one they're unchanged. New docs page: Typed events.
