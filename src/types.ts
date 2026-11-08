import type { QueryResult, QueryResultRow } from "pg";

/** Anything that can run a query: a `pg.Pool`, a `pg.PoolClient`, or a `pg.Client`. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface Endpoint {
  id: string;
  tenantId: string;
  url: string;
  description: string | null;
  /** `null` means the endpoint receives every event type. */
  eventTypes: string[] | null;
  secret: string;
  metadata: Record<string, unknown>;
  disabled: boolean;
  disabledReason: string | null;
  /** When the current unbroken run of failed attempts started, if any. */
  failingSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEndpointInput {
  tenantId: string;
  url: string;
  description?: string;
  /** Omit or pass `null` to receive every event type. */
  eventTypes?: string[] | null;
  /** Bring your own `whsec_...` secret. Generated when omitted. */
  secret?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateEndpointInput {
  url?: string;
  description?: string | null;
  eventTypes?: string[] | null;
  metadata?: Record<string, unknown>;
  /** Setting `false` re-enables an endpoint and clears its failure state. */
  disabled?: boolean;
}

export interface Message {
  id: string;
  tenantId: string;
  eventType: string;
  payload: unknown;
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface SendInput {
  tenantId: string;
  eventType: string;
  /** Any JSON-serialisable value. Delivered as `data` in the envelope. */
  payload: unknown;
  /** Sending twice with the same key (per tenant) creates one message. */
  idempotencyKey?: string;
}

export interface SendOptions {
  /**
   * Run the insert on this connection, e.g. a client inside your own
   * transaction, so the webhook is only queued if your transaction commits
   * (transactional outbox).
   */
  client?: Queryable;
}

export interface SendResult {
  message: Message;
  /** Number of deliveries queued (one per matching, enabled endpoint). */
  deliveryCount: number;
  /** `true` when an existing message was returned for the idempotency key. */
  deduplicated: boolean;
}

export type DeliveryStatus = "pending" | "delivering" | "succeeded" | "failed";

export interface Delivery {
  id: string;
  messageId: string;
  endpointId: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Attempt {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  statusCode: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number;
  createdAt: Date;
}

export interface ListDeliveriesInput {
  messageId?: string;
  endpointId?: string;
  status?: DeliveryStatus;
  limit?: number;
}

/** The JSON body POSTed to endpoints (Standard Webhooks envelope). */
export interface WebhookEnvelope<T = unknown> {
  type: string;
  timestamp: string;
  data: T;
}
