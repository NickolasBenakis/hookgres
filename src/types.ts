import type { QueryResult, QueryResultRow } from "pg";

/**
 * Anything that can run a query: a `pg.Pool`, a `pg.PoolClient`, or a
 * `pg.Client`. Pass your transaction's client as `send()`'s `client`.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * A URL that receives one tenant's webhooks, as returned by `createEndpoint`,
 * `getEndpoint` and `listEndpoints`.
 */
export interface Endpoint {
  /** `ep_...` id. */
  id: string;
  /** Your id for the customer that owns this endpoint. */
  tenantId: string;
  url: string;
  description: string | null;
  /** `null` means the endpoint receives every event type. */
  eventTypes: string[] | null;
  /** `whsec_...` signing secret. Show it to the tenant, never log it. */
  secret: string;
  /** Your own JSON data, stored as given. */
  metadata: Record<string, unknown>;
  /** Disabled endpoints get no new deliveries. Re-enable with `updateEndpoint(id, { disabled: false })`. */
  disabled: boolean;
  /** Why it was disabled (manually, or automatically after failing). */
  disabledReason: string | null;
  /** When the current unbroken run of failed attempts started, if any. */
  failingSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for `createEndpoint`.
 *
 * @example
 * const input: CreateEndpointInput = {
 *   tenantId: session.tenantId, // from the session, never the request body
 *   url: "https://example.com/webhooks",
 *   eventTypes: ["invoice.*"],
 * };
 */
export interface CreateEndpointInput<E extends EventMap = AnyEvents> {
  /** Your id for the customer that owns this endpoint. Take it from the session. */
  tenantId: string;
  /** Absolute http(s) URL. */
  url: string;
  description?: string;
  /**
   * Omit or pass `null` to receive every event type. `"invoice.*"` matches
   * every event type that starts with `"invoice."`.
   */
  eventTypes?: EventTypeFilter<E>[] | null;
  /** Bring your own `whsec_...` secret. Generated when omitted. */
  secret?: string;
  /** Your own JSON data. Defaults to `{}`. */
  metadata?: Record<string, unknown>;
}

/**
 * Patch for `updateEndpoint`: only the fields given change.
 *
 * @example
 * const patch: UpdateEndpointInput = { url: "https://example.com/v2/webhooks" };
 */
export interface UpdateEndpointInput<E extends EventMap = AnyEvents> {
  url?: string;
  description?: string | null;
  eventTypes?: EventTypeFilter<E>[] | null;
  metadata?: Record<string, unknown>;
  /** Setting `false` re-enables an endpoint and clears its failure state. */
  disabled?: boolean;
}

/** One event as sent with `send()`. Each matching endpoint gets a `Delivery` of it. */
export interface Message {
  /** `msg_...` id, sent as the `webhook-id` header. */
  id: string;
  tenantId: string;
  eventType: string;
  /** The payload as sent, or `null` once redacted (see `redactedAt`). */
  payload: unknown;
  idempotencyKey: string | null;
  createdAt: Date;
  /**
   * When the payload was cleared by `redactPayloads`, or `null`. A redacted
   * message keeps its delivery log but can't be replayed.
   */
  redactedAt: Date | null;
}

/**
 * The event for `send()`. With an event map (`Hookgres<Events>` or
 * `schemas`), `eventType` must be one of its keys and `payload` must match.
 *
 * @example
 * const input: SendInput = {
 *   tenantId: "acme",
 *   eventType: "invoice.paid",
 *   payload: { invoiceId: "inv_123" },
 *   idempotencyKey: "invoice.paid:inv_123",
 * };
 */
export type SendInput<E extends EventMap = AnyEvents> = {
  [K in keyof E & string]: {
    /** Whose endpoints receive it. A tenant with no endpoints is not an error. */
    tenantId: string;
    /** A concrete event type like `"invoice.paid"`; no `*` wildcards. */
    eventType: K;
    /**
     * Any JSON-serialisable value. Delivered as `data` in the envelope. With
     * `schemas`, it is validated, and the schema's output is what's stored.
     */
    payload: E[K];
    /** Sending twice with the same key (per tenant) creates one message. */
    idempotencyKey?: string;
  };
}[keyof E & string];

/** Options for `send()`. */
export interface SendOptions {
  /**
   * Run the insert on this connection, e.g. a client inside your own
   * transaction, so the webhook is only queued if your transaction commits
   * (transactional outbox). Without it, `send()` runs on the pool, outside
   * your transaction.
   */
  client?: Queryable;
}

/** What `send()` returns. */
export interface SendResult {
  /** The stored message, or the original one when `deduplicated`. */
  message: Message;
  /** Number of deliveries queued (one per matching, enabled endpoint). */
  deliveryCount: number;
  /** `true` when an existing message was returned for the idempotency key. */
  deduplicated: boolean;
}

/**
 * `pending`: waiting for its next attempt. `delivering`: claimed by a worker.
 * `succeeded`: got a 2xx. `failed`: out of retries, or its endpoint is
 * disabled (replay it with `replayDelivery`).
 */
export type DeliveryStatus = "pending" | "delivering" | "succeeded" | "failed";

/** One message on its way to one endpoint. */
export interface Delivery {
  id: string;
  messageId: string;
  endpointId: string;
  status: DeliveryStatus;
  /** HTTP attempts so far. Reset to 0 by `replayDelivery`. */
  attemptCount: number;
  /** When it is due (for `pending`). */
  nextAttemptAt: Date;
  /** Error of the latest failed attempt, e.g. `HTTP 500`. */
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One HTTP request of a delivery, as listed by `listAttempts`. */
export interface Attempt {
  id: string;
  deliveryId: string;
  /** 1 for the first attempt. */
  attemptNumber: number;
  /** `null` for timeouts, network errors and blocked addresses. */
  statusCode: number | null;
  /**
   * The start of the response body, up to `responseBodyLimit` characters
   * (4,096 by default). `null` when there was none or `responseBodyLimit` is 0.
   */
  responseBody: string | null;
  /** `null` on success, otherwise e.g. `HTTP 500` or `Timed out after 15000ms`. */
  error: string | null;
  durationMs: number;
  createdAt: Date;
}

/**
 * Options for `cleanup()`.
 *
 * @example
 * await hookgres.cleanup({ olderThan: 30 * 24 * 60 * 60 * 1000 }); // 30 days
 */
export interface CleanupOptions {
  /** Delete messages created before this `Date`, or more than this many ms ago. */
  olderThan: Date | number;
  /** Messages deleted per statement. Defaults to 1000. */
  batchSize?: number;
}

/**
 * Which messages `deleteMessages()` deletes. Give at least one filter; they
 * combine with AND.
 *
 * @example
 * // Erase every webhook about one person, for one tenant
 * await hookgres.deleteMessages({
 *   tenantId: "acme",
 *   payloadContains: { userId: "usr_123" },
 * });
 */
export interface DeleteMessagesFilter {
  /** Only this tenant's messages. Alone, deletes all of them (offboarding). */
  tenantId?: string;
  /** Only these message ids. */
  messageIds?: string[];
  /**
   * Only messages whose payload contains this JSON (Postgres `@>`), e.g.
   * `{ userId: "usr_123" }`. Scans the tenant's messages, or every message
   * without `tenantId`.
   */
  payloadContains?: Record<string, unknown> | unknown[];
  /** Messages deleted per statement. Defaults to 1000. */
  batchSize?: number;
}

/**
 * Options for `drain()`.
 *
 * @example
 * const delivered = await hookgres.drain({ timeoutMs: 50_000 }); // 60s function limit
 */
export interface DrainOptions {
  /**
   * Time in ms `drain()` may run. It returns before this, never starting a
   * batch it can't finish in time (see `requestTimeoutMs`). Set it a few
   * seconds below your function's time limit. Must be at least
   * `requestTimeoutMs + 1000`.
   */
  timeoutMs: number;
}

/** Filters for `listDeliveries`. All are optional and combine with AND. */
export interface ListDeliveriesInput {
  messageId?: string;
  endpointId?: string;
  status?: DeliveryStatus;
  /** Defaults to 50, capped at 500. */
  limit?: number;
}

/** What happened to a delivery after one attempt. */
export type AttemptOutcome = "succeeded" | "retrying" | "failed";

/** Passed to the `onAttempt` hook after every HTTP attempt. */
export interface AttemptEvent {
  deliveryId: string;
  messageId: string;
  endpointId: string;
  tenantId: string;
  eventType: string;
  /** 1 for the first attempt. Starts again at 1 after a replay. */
  attemptNumber: number;
  /** `retrying` means another attempt is due at `nextAttemptAt`. */
  outcome: AttemptOutcome;
  /** `null` for timeouts, network errors and blocked addresses. */
  statusCode: number | null;
  /** `null` on success, otherwise e.g. `HTTP 500` or `Timed out after 15000ms`. */
  error: string | null;
  durationMs: number;
  /** When the next attempt is due. Only set when `outcome` is `retrying`. */
  nextAttemptAt: Date | null;
}

/** Passed to the `onEndpointDisabled` hook when Hookgres disables an endpoint. */
export interface EndpointDisabledEvent {
  endpointId: string;
  tenantId: string;
  /** The endpoint's new `disabledReason`. */
  reason: string;
}

/**
 * Every event `verifyWebhook` can return for an event map, as a union you can
 * narrow on `type`. Pass `InferEvents<typeof schemas>` when you use `schemas`.
 *
 * @example
 * type Events = { "invoice.paid": { id: string }; "invoice.voided": { id: string } };
 * const event = verifyWebhook<WebhookEvent<Events>>({ secret, headers, body });
 * if (event.type === "invoice.paid") markPaid(event.data.id);
 */
export type WebhookEvent<E extends EventMap = AnyEvents> = {
  [K in keyof E & string]: WebhookEnvelope<Jsonified<E[K]>> & { type: K };
}[keyof E & string];

/**
 * What a value looks like after a JSON round trip, which is what receivers
 * get: a `Date` (from `z.coerce.date()`, say) arrives as an ISO string, and
 * functions and `undefined` properties are dropped. `WebhookEvent` applies
 * it to each event's data.
 *
 * @example
 * type Out = Jsonified<{ at: Date; n: number }>; // { at: string; n: number }
 */
export type Jsonified<T> = unknown extends T
  ? T
  : T extends { toJSON(...args: never[]): infer J }
    ? Jsonified<J>
    : T extends string | number | boolean | null
      ? T
      : T extends bigint | symbol | undefined | ((...args: never[]) => unknown)
        ? never
        : T extends ReadonlyArray<infer U>
          ? Jsonified<U>[]
          : { [K in keyof T]: Jsonified<T[K]> };

/**
 * The JSON body POSTed to endpoints (Standard Webhooks envelope), and what
 * `verifyWebhook` returns.
 *
 * @example
 * const event = verifyWebhook<WebhookEnvelope<{ invoiceId: string }>>({ secret, headers, body });
 * if (event.type === "invoice.paid") markPaid(event.data.invoiceId);
 */
export interface WebhookEnvelope<T = unknown> {
  /** The event type passed to `send()`. */
  type: string;
  /** ISO 8601 time the message was created. */
  timestamp: string;
  /** The payload passed to `send()`. */
  data: T;
}

// ---------------------------------------------------------------- typed events

/**
 * Maps each event type to its payload type, e.g.
 * `{ "invoice.paid": { id: string; amount: number } }`. Pass it as
 * `new Hookgres<Events>()`, or let Hookgres infer it from `schemas`.
 *
 * @see https://hookgres.dev/docs/guides/typed-events
 */
// `any`, not `unknown`: interfaces have no implicit index signature, so only
// `Record<string, any>` accepts `interface Events { ... }`.
// biome-ignore lint/suspicious/noExplicitAny: see above
export type EventMap = Record<string, any>;

/** The default event map: any event type, any payload. */
export type AnyEvents = Record<string, unknown>;

/**
 * The `eventTypes` an endpoint can subscribe to: a known event type, or a
 * wildcard like `"invoice.*"` that matches at least one. Any other string is
 * still accepted by the type (endpoint filters usually come from your
 * customers at runtime); with `schemas`, Hookgres rejects it at runtime.
 */
export type EventTypeFilter<E extends EventMap = AnyEvents> =
  | (keyof E & string)
  | WildcardsOf<keyof E & string>
  | (string & {});

/** `"a.b.c"` becomes `"a.*" | "a.b.*"`. */
type WildcardsOf<T extends string> = T extends `${infer Head}.${infer Rest}`
  ? `${Head}.*` | `${Head}.${WildcardsOf<Rest>}`
  : never;

/**
 * One Standard Schema per event type, e.g. Zod, Valibot or ArkType schemas.
 * `send()` validates each payload against its event type's schema.
 *
 * @example
 * const schemas = {
 *   "invoice.paid": z.object({ id: z.string(), amount: z.number() }),
 * } satisfies EventSchemas;
 */
export type EventSchemas<E extends EventMap = AnyEvents> = {
  [K in keyof E]: StandardSchemaV1<E[K], unknown>;
};

/**
 * The payload types your receivers get for a set of `schemas`: each schema's
 * output, which is what `send()` stores and delivers.
 *
 * @example
 * type Events = InferEvents<typeof schemas>;
 * const event = verifyWebhook<WebhookEvent<Events>>({ secret, headers, body });
 */
export type InferEvents<S extends Record<string, StandardSchemaV1>> = {
  [K in keyof S]: StandardSchemaV1.InferOutput<S[K]>;
};

/**
 * The Standard Schema interface (https://standardschema.dev), implemented by
 * Zod 3.24+ and 4, Valibot, ArkType and others. Copied from the spec, as it
 * recommends, so Hookgres doesn't depend on any schema library.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export interface PathSegment {
    readonly key: PropertyKey;
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["input"];
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["output"];
}
