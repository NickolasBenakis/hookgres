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

## With schemas

Pass one schema per event type. Hookgres infers the types from them, so
there's nothing else to declare:

```ts
import pg from "pg";
import { Hookgres } from "hookgres";
import { z } from "zod";

export const schemas = {
  "invoice.paid": z.object({ invoiceId: z.string(), amount: z.number() }),
  "invoice.voided": z.object({ invoiceId: z.string() }),
  "customer.created": z.object({ customerId: z.string() }),
};

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const hookgres = new Hookgres({ pool, schemas });
```

```ts
await hookgres.send(
  { tenantId, eventType: "invoice.paid", payload: { invoiceId: id, amount } },
  { client },
);

await hookgres.send({
  tenantId,
  eventType: "invoice.paid",
  payload: { invoiceId: id }, // ✗ compile error: amount is missing
});
```

At runtime, `send()` validates the payload before writing anything. If it's
invalid, the event type has no schema, or the schema throws, `send()` throws
a `HookgresValidationError` and nothing is queued. Your transaction is still
usable, because validation runs no SQL.

For an invalid payload, the error's message names the failing paths, and
`issues` holds the schema library's issues, each with a `message` and a
`path`:

```ts
try {
  await hookgres.send({ tenantId, eventType: "invoice.paid", payload });
} catch (error) {
  if (error instanceof HookgresValidationError && error.issues) {
    // error.message: Invalid payload for "invoice.paid": payload.amount failed the schema ...
    logger.warn({ issues: error.issues }, error.message);
  }
  throw error;
}
```

Some libraries quote the received value in their issue messages, so treat
`issues` like the payload itself: fine for your logs if payloads are, but
don't return it to API callers. The message never includes payload values.

Hookgres stores and delivers the schema's **output**, so transforms run
before the payload is stored. A Zod or Valibot object drops keys it doesn't
declare, so a field you didn't mean to send never reaches a customer. Loose
objects (`z.looseObject`, `v.looseObject`) and ArkType objects keep them by
default. Each payload is
validated once per `send()`.

Any library that implements [Standard Schema](https://standardschema.dev)
works: Zod 3.24+ and 4, Valibot 1, ArkType and others. You can mix them in
one `schemas` object.

### Endpoint filters

With `schemas`, `createEndpoint()` and `updateEndpoint()` also reject
`eventTypes` that match no event type you declared, such as
`"invoice.piad"`, or `"order.*"` when there's no `order.` event. These
usually come from your customers, so return the error as a `400`. The
message doesn't list your event types. `null`
(every event type) is always allowed.

## With an event map

If you only want compile-time checks, pass a type instead. Nothing changes at
runtime:

```ts
type Events = {
  "invoice.paid": { invoiceId: string; amount: number };
  "invoice.voided": { invoiceId: string };
};

const hookgres = new Hookgres<Events>({ pool });
```

## On the receiver

Your customers' receivers often aren't TypeScript, so this part is for your
own receivers and tests. `WebhookEvent` turns an event map into a union you
can narrow on `type`:

```ts
import { verifyWebhook, type InferEvents, type WebhookEvent } from "hookgres";
import type { schemas } from "./hookgres";

type Events = InferEvents<typeof schemas>; // or your event map

const event = verifyWebhook<WebhookEvent<Events>>({ secret, headers, body });
if (event.type === "invoice.paid") {
  event.data.amount; // number
}
```

`InferEvents` gives the schemas' output types, which is what Hookgres
delivers. `verifyWebhook` checks the signature, not the shape. To check the
shape on the receiver too, parse `event.data` with the same schema.

## What isn't typed

- `Message.payload` from `getMessage()` stays `unknown`. Messages stored
  before you added a schema, or redacted ones, may not match it.
- Event types in the `onAttempt` hook and the delivery log are plain
  strings.
