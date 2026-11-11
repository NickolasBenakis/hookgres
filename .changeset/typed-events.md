---
"hookgres": minor
---

Add typed events. Pass one [Standard Schema](https://standardschema.dev) per event type, such as a Zod (3.24+ or 4), Valibot or ArkType schema, as `new Hookgres({ pool, schemas })`, and `send()` is typed from them: a misspelled event type or a payload that doesn't match fails to compile. At runtime, `send()` validates each payload before writing and stores the schema's output, so transforms are applied and, with Zod or Valibot objects, undeclared keys are dropped. An invalid payload throws a `HookgresValidationError` whose message names the failing paths and whose `issues` holds the schema's issues; an event type with no schema, or a schema that throws, also throws a `HookgresValidationError`. Nothing is queued in any of these cases. With `schemas`, `createEndpoint()` and `updateEndpoint()` also reject `eventTypes` that match no declared event type. For compile-time checks only, use `new Hookgres<Events>({ pool })` with an event map. Hookgres still has no runtime dependencies besides `pg`.

New types: `EventMap`, `AnyEvents`, `EventSchemas`, `EventTypeFilter`, `InferEvents`, `WebhookEvent` (a union of envelopes to narrow on `type` after `verifyWebhook`) and `StandardSchemaV1`. `SendInput`, `CreateEndpointInput` and `UpdateEndpointInput` take an optional event map; without one they're unchanged. New docs page: Typed events.
