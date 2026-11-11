# Typed events

By default, `send()` takes any event type and any payload. Give Hookgres
your event types and TypeScript checks every `send()`: a misspelled event
type or a missing field fails to compile, instead of reaching your
customers.

There are two ways to do it. Both work without adding a dependency to
Hookgres.

| You want                            | Use                               |
| ----------------------------------- | --------------------------------- |
| Compile-time checks only            | An event map: `Hookgres<Events>`  |
| Compile-time and runtime validation | `schemas` (Zod, Valibot, ArkType) |

The code on this page runs in Hookgres's CI.

## With schemas

Write one schema per event type:

<<< @/snippets/typed-events/schemas.ts

Pass them to `new Hookgres()`. Hookgres infers the types from them, so
there's nothing else to declare:

<<< @/snippets/typed-events/hookgres.ts

Then `send()` is typed and validated:

<<< @/snippets/typed-events/send.ts

A payload that doesn't match its event type fails to compile:

```ts
await hookgres.send({
  tenantId,
  eventType: "invoice.paid",
  payload: { invoiceId }, // ✗ compile error: amount is missing
});
```

At runtime, `send()` validates the payload before writing anything. If it's
invalid, the event type has no schema, or the schema throws, `send()` throws
a `HookgresValidationError` and nothing is queued. Your transaction is still
usable, because validation runs no SQL.

For an invalid payload, the error's message names the failing paths, such as
`Invalid payload for "invoice.paid": payload.amount failed the schema`, and
`issues` holds the schema library's issues, each with a `message` and a
`path`. Some libraries quote the received value in their issue messages, so
treat `issues` like the payload itself: fine for your logs if payloads are,
but don't return it to API callers. The message never includes payload
values.

Hookgres stores and delivers the schema's **output**, so transforms run
before the payload is stored. A Zod or Valibot object drops keys it doesn't
declare, so a field you didn't mean to send never reaches a customer. Loose
objects (`z.looseObject`, `v.looseObject`) and ArkType objects keep them by
default. Each payload is validated once per `send()`.

Any library that implements [Standard Schema](https://standardschema.dev)
works: Zod 3.24+ and 4, Valibot 1, ArkType 2 and others. You can mix them in
one `schemas` object.

### Endpoint filters

With `schemas`, `createEndpoint()` and `updateEndpoint()` also reject
`eventTypes` that match no event type you declared, such as
`"invoice.piad"`, or `"order.*"` when there's no `order.` event. These
usually come from your customers, so return the error as a `400`. The
message doesn't list your event types. `null` (every event type) is always
allowed.

## With an event map

If you only want compile-time checks, pass a type instead. Nothing changes at
runtime:

<<< @/snippets/typed-events/event-map.ts

## On the receiver

Your customers' receivers often aren't TypeScript, so this part is for your
own receivers and tests. `WebhookEvent` turns an event map into a union you
can narrow on `type`, and `InferEvents` gives the schemas' output types,
which is what Hookgres stores and sends. `WebhookEvent` types each event's
`data` as it arrives after JSON: a `Date` from `z.coerce.date()` is an ISO
string on the receiver. Schema output must be JSON: `send()` rejects a `Map`,
a `Set` or a `BigInt`.

<<< @/snippets/typed-events/receiver.ts

`verifyWebhook` checks the signature, not the shape. To check the shape on
the receiver too, parse `event.data` with the same schema.

## What isn't typed

- `Message.payload` from `getMessage()` stays `unknown`. Messages stored
  before you added a schema, or redacted ones, may not match it.
- Event types in the `onAttempt` hook and the delivery log are plain
  strings.
