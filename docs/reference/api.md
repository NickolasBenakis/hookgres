# API

Everything is exported from `hookgres`, except the
[ORM adapters](#orm-adapters):

```ts
import {
  Hookgres,
  DEFAULT_RETRY_SCHEDULE,
  HookgresValidationError,
  verifyWebhook,
  sign,
  generateSecret,
  assertSecret,
  WebhookVerificationError,
  isPrivateAddress,
} from "hookgres";
```

Methods that look something up by id return `null` when it doesn't exist.
Invalid arguments throw a [`HookgresValidationError`](#hookgresvalidationerror).

## `new Hookgres(options)`

Creates a client. Pass either `pool` (a `pg.Pool` you own) or
`connectionString` (Hookgres creates and owns the pool). All options are
listed in [Configuration](/reference/configuration).

The pool is available as `hookgres.pool`.

## Setup

### `migrate(): Promise<void>`

Creates or upgrades the schema and tables. Safe to call on every boot and
concurrently, because it holds an advisory lock while it runs.

## Endpoints

### `createEndpoint(input): Promise<Endpoint>`

| Field         | Type                      | Notes                                                                                              |
| ------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `tenantId`    | `string`                  | Required.                                                                                          |
| `url`         | `string`                  | Required. `http:` or `https:`.                                                                     |
| `description` | `string`                  | Optional.                                                                                          |
| `eventTypes`  | `string[] \| null`        | Omit or `null` for every event. Can't be empty. `"invoice.*"` matches every type under `invoice.`. |
| `secret`      | `string`                  | Optional `whsec_...` secret with 24–64 bytes. Generated if omitted.                                |
| `metadata`    | `Record<string, unknown>` | Optional. Defaults to `{}`.                                                                        |

### `getEndpoint(id): Promise<Endpoint | null>`

### `listEndpoints(tenantId): Promise<Endpoint[]>`

All endpoints of a tenant, oldest first.

### `updateEndpoint(id, patch): Promise<Endpoint | null>`

`patch` accepts `url`, `description`, `eventTypes`, `metadata` and
`disabled`. Only the fields you pass change. `disabled: false` re-enables an
endpoint and clears `failingSince` and `disabledReason`. `disabled: true`
sets the reason to `Disabled manually`.

### `deleteEndpoint(id): Promise<boolean>`

Deletes the endpoint with its deliveries and attempts. Returns whether it
existed.

### `rotateEndpointSecret(id, options?): Promise<Endpoint | null>`

Generates a new secret, or uses `options.secret`. The old secret keeps
signing for `options.graceMs`, which defaults to `secretRotationGraceMs`
(24 hours). See [Rotating secrets](/guides/secret-rotation).

## Messages

### `send(input, options?): Promise<SendResult>`

| Field            | Type      | Notes                                  |
| ---------------- | --------- | -------------------------------------- |
| `tenantId`       | `string`  | Required.                              |
| `eventType`      | `string`  | Required. Can't contain `*`.           |
| `payload`        | `unknown` | Required. Any JSON-serialisable value. |
| `idempotencyKey` | `string`  | Optional. Unique per tenant.           |

`options.client` runs the insert on your own connection, for example inside
your transaction. Returns `{ message, deliveryCount, deduplicated }`. See
[Sending webhooks](/guides/sending).

With an event map (`new Hookgres<Events>()`) or `schemas`, `eventType` must
be one of its event types and `payload` must match its type. With `schemas`,
the payload is validated first and the schema's output is stored. See
[Typed events](/guides/typed-events).

### `getMessage(id): Promise<Message | null>`

With `redactPayloads`, `payload` is `null` once `redactedAt` is set.

### `cleanup(options): Promise<number>`

Deletes messages created before `options.olderThan` whose deliveries are all
finished, together with their deliveries and attempts. Messages with a
`pending` or `delivering` delivery are kept. `olderThan` is a `Date` or a
number of milliseconds ago. `options.batchSize` (default 1000) is how many
messages each `DELETE` removes; it repeats until none are left. Returns the
number of messages deleted. See
[Clean up old rows](/guides/production#clean-up-old-rows).

### `deleteMessages(filter): Promise<number>`

Deletes the messages that match every filter given, with their deliveries
and attempts, whatever their status, and returns how many it deleted. For
erasure requests and offboarding a tenant.

| Field             | Type                                   | Notes                                                |
| ----------------- | -------------------------------------- | ---------------------------------------------------- |
| `tenantId`        | `string`                               | Only this tenant's messages.                         |
| `messageIds`      | `string[]`                             | Only these messages. An empty array deletes nothing. |
| `payloadContains` | `Record<string, unknown> \| unknown[]` | Only payloads containing this JSON (Postgres `@>`).  |
| `batchSize`       | `number`                               | Messages per `DELETE`, default 1000.                 |

At least one of `tenantId`, `messageIds` and `payloadContains` is required.
Pending deliveries of a deleted message are never sent. Endpoints are kept.
See [Privacy and GDPR](/guides/privacy#erase-on-request).

## Deliveries

### `getDelivery(id): Promise<Delivery | null>`

### `listDeliveries(filter?): Promise<Delivery[]>`

Newest first. `filter` accepts `messageId`, `endpointId`, `status` and
`limit` (default 50, maximum 500).

### `stats(filter?): Promise<QueueStats>`

The queue right now: `pending`, `due`, `delivering`, `oldestDueAt` and
`lagMs`, how long the oldest due delivery has waited. `filter` accepts
`tenantId` and `endpointId`. See [Metrics and traces](/guides/observability).

### `listAttempts(deliveryId): Promise<Attempt[]>`

Oldest first.

### `replayDelivery(id): Promise<Delivery | null>`

Sends a `succeeded` or `failed` delivery again with a fresh retry schedule.
Returns `null` if it doesn't exist or is still `pending` or `delivering`.
Throws a `HookgresValidationError` if its payload was redacted
(`redactPayloads`).

## Worker

### `start(): void`

Starts the delivery loop in this process. Calling it again does nothing.
With the `notify` option, it also takes one pool connection that LISTENs for
wake-ups. See [Instant wake-up](/guides/workers#instant-wake-up-with-listen-notify).

### `stop(): Promise<void>`

Stops claiming deliveries, closes the LISTEN connection if there is one, and
waits for in-flight requests to finish. You can call `start()` again
afterwards.

### `close(): Promise<void>`

Calls `stop()`, then closes the pool if Hookgres created it from
`connectionString`. A pool you passed in is never closed.

### `runOnce(): Promise<number>`

Claims up to `concurrency` due deliveries, sends them, waits for all of them,
and returns how many it claimed. Use it from cron or serverless functions
instead of `start()`, usually through `drain()`.

### `drain({ timeoutMs }): Promise<number>`

Calls `runOnce()` until a batch finds nothing due, and returns the total it
processed. It returns within `timeoutMs`: a batch can take up to
`requestTimeoutMs`, so it only starts one while at least `requestTimeoutMs`
plus 1 second is left (or the slowest batch so far, if that took longer).
`timeoutMs` must be at least `requestTimeoutMs + 1000`. Set it a few seconds
below your function's time limit:

```ts
const delivered = await hookgres.drain({ timeoutMs: 50_000 }); // maxDuration 60
```

See [Cron or serverless](/guides/workers#cron-or-serverless).

## Signing helpers

### `verifyWebhook<T>(options): T`

Verifies a webhook and returns its parsed body. Throws
`WebhookVerificationError` otherwise.

| Option             | Type                 | Notes                                                      |
| ------------------ | -------------------- | ---------------------------------------------------------- |
| `secret`           | `string \| string[]` | One secret, or several during a rotation.                  |
| `headers`          | object or `Headers`  | Node-style headers object, or anything with `.get()`.      |
| `body`             | `string \| Buffer`   | The raw body, exactly as received.                         |
| `toleranceSeconds` | `number`             | Maximum clock difference, at least `0`. Defaults to `300`. |
| `now`              | `number`             | Current time in milliseconds, for tests.                   |

### `sign(secret, id, timestamp, body): string`

Returns a `v1,<base64>` signature, the same one Hookgres puts in the
`webhook-signature` header. `timestamp` is in Unix seconds. Useful for
testing your own receivers.

### `generateSecret(): string`

Returns a new `whsec_` secret with 24 random bytes.

### `assertSecret(secret): string`

Throws if `secret` isn't a valid `whsec_` secret with 24–64 bytes, and
otherwise returns it.

### `WebhookVerificationError`

The error class `verifyWebhook` throws.

## Errors

### `HookgresValidationError`

Thrown when an argument or option you passed is invalid: an endpoint URL
that isn't `http(s)`, or with `blockPrivateAddresses` points to a private
address or blocked port; an empty or malformed `eventTypes`; a malformed
secret; a `send()` event type with `*`, a missing payload, or a payload with
`\u0000`; with `schemas`, a payload that fails its schema (the message names
the failing paths, and `issues` has the details), a schema that throws, an
event type with no schema, or endpoint `eventTypes`
that match none; invalid `cleanup()`, `deleteMessages()` or `drain()` arguments;
replaying a redacted delivery; and invalid
`new Hookgres()` options. It extends `Error`, and its message says how to fix
the problem, so routes can return it as a `400`:

```ts
try {
  await hookgres.createEndpoint({ tenantId, url, eventTypes });
} catch (error) {
  if (!(error instanceof HookgresValidationError)) throw error; // a 500
  return Response.json({ error: error.message }, { status: 400 });
}
```

Database errors are passed through unchanged (`pg` errors with a `code`).
Through `fromPrisma()`, every database error, including the `\u0000` one,
arrives as Prisma's own error instead.

## ORM adapters

`send()`'s `client` option takes anything with a node-postgres style
`query(text, values)`. These turn an ORM's transaction into one, so the
webhook commits or rolls back with it:

```ts
import { fromKysely } from "hookgres/kysely";
import { fromPrisma } from "hookgres/prisma";

await hookgres.send(input, { client: fromKysely(trx) }); // Kysely transaction
await hookgres.send(input, { client: fromPrisma(tx) }); // Prisma interactive transaction
```

Install `kysely` or `@prisma/client` yourself; Hookgres doesn't depend on
them. See the [Kysely](/guides/kysely) and [Prisma](/guides/prisma) guides.
Drizzle needs no adapter; see [Drizzle](/guides/drizzle).

## Other helpers

### `isPrivateAddress(ip): boolean`

Returns `true` if `ip` is an address the `blockPrivateAddresses` option
blocks: private, loopback, link-local, multicast or reserved, including IPv6
forms that carry such an IPv4 address, like `::ffff:127.0.0.1`. Ignores an
IPv6 zone id (`fe80::1%eth0`). Returns `false` for anything that isn't an IP
address, including hostnames. Use it to put the same check in a custom
`fetch` transport.

### `DEFAULT_RETRY_SCHEDULE`

The default waits between attempts, in milliseconds:
`[5s, 5m, 30m, 2h, 5h, 10h, 10h]`.

## Types

```ts
interface Endpoint {
  id: string; // "ep_..."
  tenantId: string;
  url: string;
  description: string | null;
  eventTypes: string[] | null; // null = every event type
  secret: string;
  metadata: Record<string, unknown>;
  disabled: boolean;
  disabledReason: string | null;
  failingSince: Date | null; // start of the current run of failures
  createdAt: Date;
  updatedAt: Date;
}

interface Message {
  id: string; // "msg_...", also the webhook-id header
  tenantId: string;
  eventType: string;
  payload: unknown; // null once redacted
  idempotencyKey: string | null;
  createdAt: Date;
  redactedAt: Date | null; // set by redactPayloads
}

// Typed events (see /guides/typed-events)
type EventMap = Record<string, unknown>; // { "invoice.paid": { id: string } }
type EventSchemas<E> = { [K in keyof E]: StandardSchemaV1<E[K], unknown> };
type InferEvents<S> = { [K in keyof S]: /* output type of S[K] */ };
type WebhookEvent<E> = /* WebhookEnvelope<E[K]> & { type: K }, for each K */;

interface SendResult {
  message: Message;
  deliveryCount: number;
  deduplicated: boolean;
}

type DeliveryStatus = "pending" | "delivering" | "succeeded" | "failed";

interface Delivery {
  id: string; // "dlv_..."
  messageId: string;
  endpointId: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Attempt {
  id: string; // "att_..."
  deliveryId: string;
  attemptNumber: number;
  statusCode: number | null; // null for timeouts and network errors
  responseBody: string | null; // first responseBodyLimit (4,096) characters
  error: string | null;
  durationMs: number;
  createdAt: Date;
}

// Passed to the onAttempt option after every HTTP attempt.
interface AttemptEvent {
  deliveryId: string;
  messageId: string;
  endpointId: string;
  tenantId: string;
  eventType: string;
  attemptNumber: number; // starts again at 1 after a replay
  outcome: AttemptOutcome;
  statusCode: number | null; // null for timeouts and network errors
  error: string | null; // null on success
  durationMs: number;
  nextAttemptAt: Date | null; // set only when outcome is "retrying"
}

type AttemptOutcome = "succeeded" | "retrying" | "failed";

// Passed to the onEndpointDisabled option.
interface EndpointDisabledEvent {
  endpointId: string;
  tenantId: string;
  reason: string; // the endpoint's new disabledReason
}

interface QueueStats {
  pending: number; // waiting, including retries scheduled for later
  due: number; // pending and due now
  delivering: number; // claimed by a worker
  oldestDueAt: Date | null;
  lagMs: number; // how long the oldest due delivery has waited; 0 if none
}

interface WebhookEnvelope<T = unknown> {
  type: string;
  timestamp: string; // ISO 8601, when the message was created
  data: T;
}
```

`Queryable`, the type of `send()`'s `client` option, is anything with a
node-postgres style `query(text, values)` method: a `pg.Pool`, `pg.PoolClient`
or `pg.Client`, or what `fromKysely()` and `fromPrisma()` return.
