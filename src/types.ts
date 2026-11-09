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
export interface CreateEndpointInput {
  /** Your id for the customer that owns this endpoint. Take it from the session. */
  tenantId: string;
  /** Absolute http(s) URL. */
  url: string;
  description?: string;
  /**
   * Omit or pass `null` to receive every event type. `"invoice.*"` matches
   * every event type that starts with `"invoice."`.
   */
  eventTypes?: string[] | null;
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
export interface UpdateEndpointInput {
  url?: string;
  description?: string | null;
  eventTypes?: string[] | null;
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
  payload: unknown;
  idempotencyKey: string | null;
  createdAt: Date;
}

/**
 * The event for `send()`.
 *
 * @example
 * const input: SendInput = {
 *   tenantId: "acme",
 *   eventType: "invoice.paid",
 *   payload: { invoiceId: "inv_123" },
 *   idempotencyKey: "invoice.paid:inv_123",
 * };
 */
export interface SendInput {
  /** Whose endpoints receive it. A tenant with no endpoints is not an error. */
  tenantId: string;
  /** A concrete event type like `"invoice.paid"`; no `*` wildcards. */
  eventType: string;
  /** Any JSON-serialisable value. Delivered as `data` in the envelope. */
  payload: unknown;
  /** Sending twice with the same key (per tenant) creates one message. */
  idempotencyKey?: string;
}

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
  /** The first 4 KB of the response body. */
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
