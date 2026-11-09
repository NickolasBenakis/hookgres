# API

Everything is exported from `hookgres`:

```ts
import {
  Hookgres,
  DEFAULT_RETRY_SCHEDULE,
  verifyWebhook,
  sign,
  generateSecret,
  assertSecret,
  WebhookVerificationError,
  isPrivateAddress,
} from "hookgres";
```

Methods that look something up by id return `null` when it doesn't exist.

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

| Field         | Type                      | Notes                                                               |
| ------------- | ------------------------- | ------------------------------------------------------------------- |
| `tenantId`    | `string`                  | Required.                                                           |
| `url`         | `string`                  | Required. `http:` or `https:`.                                      |
| `description` | `string`                  | Optional.                                                           |
| `eventTypes`  | `string[] \| null`        | Omit or `null` for every event. Can't be empty.                     |
| `secret`      | `string`                  | Optional `whsec_...` secret with 24–64 bytes. Generated if omitted. |
| `metadata`    | `Record<string, unknown>` | Optional. Defaults to `{}`.                                         |

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
| `eventType`      | `string`  | Required.                              |
| `payload`        | `unknown` | Required. Any JSON-serialisable value. |
| `idempotencyKey` | `string`  | Optional. Unique per tenant.           |

`options.client` runs the insert on your own connection, for example inside
your transaction. Returns `{ message, deliveryCount, deduplicated }`. See
[Sending webhooks](/guides/sending).

### `getMessage(id): Promise<Message | null>`

## Deliveries

### `getDelivery(id): Promise<Delivery | null>`

### `listDeliveries(filter?): Promise<Delivery[]>`

Newest first. `filter` accepts `messageId`, `endpointId`, `status` and
`limit` (default 50, maximum 500).

### `listAttempts(deliveryId): Promise<Attempt[]>`

Oldest first.

### `replayDelivery(id): Promise<Delivery | null>`

Sends a `succeeded` or `failed` delivery again with a fresh retry schedule.
Returns `null` if it doesn't exist or is still `pending` or `delivering`.

## Worker

### `start(): void`

Starts the delivery loop in this process. Calling it again does nothing.

### `stop(): Promise<void>`

Stops claiming deliveries and waits for in-flight requests to finish. You can
call `start()` again afterwards.

### `close(): Promise<void>`

Calls `stop()`, then closes the pool if Hookgres created it from
`connectionString`. A pool you passed in is never closed.

### `runOnce(): Promise<number>`

Claims up to `concurrency` due deliveries, sends them, waits for all of them,
and returns how many it claimed. Use it from cron or serverless functions
instead of `start()`.

## Signing helpers

### `verifyWebhook<T>(options): T`

Verifies a webhook and returns its parsed body. Throws
`WebhookVerificationError` otherwise.

| Option             | Type                 | Notes                                                 |
| ------------------ | -------------------- | ----------------------------------------------------- |
| `secret`           | `string \| string[]` | One secret, or several during a rotation.             |
| `headers`          | object or `Headers`  | Node-style headers object, or anything with `.get()`. |
| `body`             | `string \| Buffer`   | The raw body, exactly as received.                    |
| `toleranceSeconds` | `number`             | Maximum clock difference. Defaults to `300`.          |
| `now`              | `number`             | Current time in milliseconds, for tests.              |

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
  payload: unknown;
  idempotencyKey: string | null;
  createdAt: Date;
}

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
  responseBody: string | null; // first 4,096 characters
  error: string | null;
  durationMs: number;
  createdAt: Date;
}

interface WebhookEnvelope<T = unknown> {
  type: string;
  timestamp: string; // ISO 8601, when the message was created
  data: T;
}
```

`Queryable`, the type of `send()`'s `client` option, is anything with a
node-postgres style `query(text, values)` method: a `pg.Pool`, `pg.PoolClient`
or `pg.Client`.
