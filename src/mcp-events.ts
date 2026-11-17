/**
 * Webhook delivery for MCP Events (SEP-3415, extension
 * `io.modelcontextprotocol/events`), on Hookgres.
 *
 * Handles `events/list`, `events/subscribe` and `events/unsubscribe` for the
 * webhook delivery mode, and `emit()` queues an event for every matching
 * subscription, optionally inside your own transaction. Each subscription is
 * a Hookgres endpoint, so deliveries are signed with Standard Webhooks,
 * retried within a bounded window, logged, and survive restarts.
 *
 * Wire `handle()` into your MCP server's request handler; this module
 * doesn't depend on an MCP SDK.
 *
 * @see https://hookgres.dev/docs/guides/mcp-events
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { HookgresValidationError } from "./errors.js";
import { Hookgres, type HookgresOptions } from "./hookgres.js";
import { newId } from "./ids.js";
import { assertSecret, sign } from "./signing.js";
import { AddressGuard, guardedTransport, type Transport } from "./ssrf.js";
import type { Queryable } from "./types.js";

export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
export const SUBSCRIPTION_ID_HEADER = "x-mcp-subscription-id";

/** SEP-3415 error codes (provisional until the SEP is accepted). */
export const McpEventsErrorCode = {
  InvalidParams: -32602,
  NotFound: -32023,
  Forbidden: -32024,
  ResourceExhausted: -32025,
  Unsupported: -32026,
  CallbackEndpointError: -32027,
} as const;

/** A JSON-RPC error to return to the client as is. */
export class McpEventsError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpEventsError";
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.data ? { data: this.data } : {}),
    };
  }
}

export interface McpEventType {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
  /** Does an event's `data` match a subscription's `arguments`? Defaults to always. */
  matches?: (args: Record<string, unknown>, data: unknown) => boolean;
}

export interface McpEventsOptions {
  pool: pg.Pool;
  events: McpEventType[];
  /** Postgres schema for the subscriptions and deliveries. Defaults to `hookgres_mcp_events`. */
  schema?: string;
  /** TTLs in ms: the default grant, and the range suggestions are clamped to. */
  ttl?: { defaultMs?: number; minMs?: number; maxMs?: number };
  /** Grant `refreshBefore: null` when a client asks for no expiry. Defaults to `false`. */
  allowNoExpiry?: boolean;
  /**
   * How a callback URL proves it wants deliveries before the first one:
   * `"handshake"` (default) POSTs a signed `verification` challenge, or a
   * function that allowlists URLs.
   */
  verify?: "handshake" | ((url: string) => boolean);
  /**
   * For local testing only: accept `http://` callback URLs and these private
   * addresses (IPs or CIDRs). Production servers must leave both off.
   */
  insecure?: { allowHttp?: boolean; allowAddresses?: string[] };
  /** Passed to the underlying Hookgres instance. */
  hookgres?: Partial<
    Omit<
      HookgresOptions,
      | "pool"
      | "schema"
      | "envelope"
      | "deliveryHeaders"
      | "blockPrivateAddresses"
      // A custom fetch would turn off the delivery-time address checks.
      | "fetch"
    >
  >;
  /** Verification POSTs allowed per destination host per minute. Defaults to 10. */
  verificationsPerHostPerMinute?: number;
}

/** SEP-3415 suggests 3-5 attempts within 10-15 minutes. */
const RETRY_SCHEDULE = [5_000, 30_000, 120_000, 300_000];
const HOUR = 3_600_000;
const MAX_ARGUMENTS_BYTES = 4096;
/** Enough for {"challenge": "..."}; a longer body can't be a valid answer. */
const MAX_CHALLENGE_RESPONSE_BYTES = 4096;

interface Subscription {
  endpointId: string;
  id: string;
  disabled: boolean;
  failingSince: Date | null;
  secret: string;
  refreshBefore: string | null;
  verified: boolean;
}

export class McpEvents {
  readonly hookgres: Hookgres;
  private readonly pool: pg.Pool;
  private readonly types: Map<string, McpEventType>;
  private readonly table: string;
  private readonly ttl: { defaultMs: number; minMs: number; maxMs: number };
  private readonly allowNoExpiry: boolean;
  private readonly verifyMode: McpEventsOptions["verify"];
  private readonly allowHttp: boolean;
  private readonly guard: AddressGuard;
  private readonly transport: { send: Transport; close(): void };
  private readonly verificationLimit: number;
  /** Verification POST times per host, for the SEP's per-host rate limit. */
  private readonly verificationLog = new Map<string, number[]>();

  constructor(options: McpEventsOptions) {
    const schema = options.schema ?? "hookgres_mcp_events";
    const allow = options.insecure?.allowAddresses ?? [];
    this.guard = new AddressGuard({ allow });
    this.transport = guardedTransport(this.guard);
    this.hookgres = new Hookgres({
      retrySchedule: RETRY_SCHEDULE,
      requestTimeoutMs: 5_000,
      // Suspension would fail queued events; TTL expiry cleans up instead.
      disableEndpointAfterMs: null,
      nonRetryableStatuses: [410, 413],
      ...options.hookgres,
      pool: options.pool,
      schema,
      envelope: false,
      blockPrivateAddresses: { allow },
      deliveryHeaders: ({ tenantId }) => ({
        [SUBSCRIPTION_ID_HEADER]: tenantId,
      }),
    });
    this.pool = options.pool;
    this.table = `"${schema}".endpoints`;
    this.types = new Map(options.events.map((type) => [type.name, type]));
    this.ttl = {
      defaultMs: options.ttl?.defaultMs ?? HOUR,
      minMs: options.ttl?.minMs ?? 60_000,
      maxMs: options.ttl?.maxMs ?? 24 * HOUR,
    };
    this.allowNoExpiry = options.allowNoExpiry ?? false;
    this.verifyMode = options.verify ?? "handshake";
    this.allowHttp = options.insecure?.allowHttp ?? false;
    this.verificationLimit = options.verificationsPerHostPerMinute ?? 10;
  }

  /** Merge into the capabilities your server returns. */
  get capabilities() {
    return { extensions: { [EVENTS_EXTENSION]: {} } };
  }

  migrate(): Promise<void> {
    return this.hookgres.migrate();
  }

  start(): void {
    this.hookgres.start();
  }

  async stop(): Promise<void> {
    await this.hookgres.stop();
    this.transport.close();
  }

  /**
   * Handles an `events/*` request. `principal` is the authenticated subject
   * (OAuth `sub`, API key id); webhook methods throw `Forbidden` without one.
   * Throws `McpEventsError`; return `error.toJSON()` as the JSON-RPC error.
   */
  async handle(
    method: string,
    params: Record<string, unknown> | undefined,
    context: { principal?: string | null },
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case "events/list":
        return this.list();
      case "events/subscribe":
        return this.subscribe(params ?? {}, context.principal);
      case "events/unsubscribe":
        return this.unsubscribe(params ?? {}, context.principal);
      case "events/poll":
      case "events/stream":
        throw new McpEventsError(
          McpEventsErrorCode.Unsupported,
          "Unsupported",
          {
            feature: "deliveryMode",
            value: method === "events/poll" ? "poll" : "push",
          },
        );
      default:
        throw new McpEventsError(-32601, `Method not found: ${method}`);
    }
  }

  list(): Record<string, unknown> {
    return {
      resultType: "complete",
      events: [...this.types.values()].map((type) => ({
        name: type.name,
        ...(type.description ? { description: type.description } : {}),
        delivery: ["webhook"],
        inputSchema: type.inputSchema ?? { type: "object" },
        ...(type.payloadSchema ? { payloadSchema: type.payloadSchema } : {}),
      })),
    };
  }

  /**
   * Queues `name` for every live subscription whose arguments match. Pass
   * your transaction's `client` and the deliveries are queued only if it
   * commits. Returns the number of subscriptions it was queued for.
   */
  async emit(
    name: string,
    data: Record<string, unknown>,
    options: { eventId?: string; timestamp?: Date; client?: Queryable } = {},
  ): Promise<number> {
    const type = this.types.get(name);
    if (!type) {
      throw new HookgresValidationError(`Unknown MCP event type "${name}"`);
    }
    const db = options.client ?? this.pool;
    const { rows } = await db.query<{
      tenant_id: string;
      metadata: { arguments?: Record<string, unknown> };
    }>(
      `SELECT tenant_id, metadata FROM ${this.table}
       WHERE $1 = ANY(event_types) AND metadata->>'verified' = 'true'
         AND (metadata->>'refreshBefore' IS NULL
              OR (metadata->>'refreshBefore')::timestamptz > now())`,
      [name],
    );
    const eventId = options.eventId ?? newId("evt");
    const timestamp = (options.timestamp ?? new Date()).toISOString();
    let queued = 0;
    for (const row of rows) {
      if (type.matches && !type.matches(row.metadata.arguments ?? {}, data)) {
        continue;
      }
      // Emit-only: no durable upstream to replay from, so no cursor.
      const payload = { eventId, name, timestamp, data, cursor: null };
      const result = await this.hookgres.send(
        {
          tenantId: row.tenant_id,
          eventType: name,
          payload,
          idempotencyKey: eventId,
        },
        { client: options.client },
      );
      if (!result.deduplicated) queued += result.deliveryCount;
    }
    return queued;
  }

  /** Deletes subscriptions past their `refreshBefore`. Returns how many. */
  async deleteExpired(): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM ${this.table}
       WHERE (metadata->>'refreshBefore')::timestamptz <= now()`,
    );
    let deleted = 0;
    // deleteEndpoint removes deliveries first, so it can't deadlock workers.
    for (const row of rows) {
      if (await this.hookgres.deleteEndpoint(row.id)) deleted++;
    }
    return deleted;
  }

  /**
   * Runs `fn` while holding a session advisory lock on the subscription id,
   * so concurrent subscribe and unsubscribe calls for one key can't race.
   */
  private async withKeyLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        id,
      ]);
      try {
        return await fn();
      } finally {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [id],
        );
      }
    } finally {
      client.release();
    }
  }

  private async subscribe(
    params: Record<string, unknown>,
    principal: string | null | undefined,
  ): Promise<Record<string, unknown>> {
    if (!principal) {
      throw new McpEventsError(McpEventsErrorCode.Forbidden, "Forbidden", {
        reason: "events/subscribe needs an authenticated principal",
      });
    }
    const { name, args, url } = this.keyParams(params);
    const delivery = params.delivery as Record<string, unknown>;
    if (delivery.mode !== undefined && delivery.mode !== "webhook") {
      throw new McpEventsError(McpEventsErrorCode.Unsupported, "Unsupported", {
        feature: "deliveryMode",
        value: delivery.mode,
      });
    }
    const secret = delivery.secret;
    try {
      assertSecret(String(secret));
    } catch {
      throw invalid(
        "delivery.secret must be whsec_ followed by base64 of 24-64 bytes",
      );
    }
    if (typeof secret !== "string")
      throw invalid("delivery.secret is required");
    const refreshBefore = this.grant(params.ttlMs);
    const id = subscriptionId(principal, url, name, args);
    return this.withKeyLock(id, () =>
      this.upsert({ id, principal, name, args, url, secret, refreshBefore }),
    );
  }

  private async upsert(input: {
    id: string;
    principal: string;
    name: string;
    args: Record<string, unknown>;
    url: string;
    secret: string;
    refreshBefore: string | null;
  }): Promise<Record<string, unknown>> {
    const { id, principal, name, args, url, secret, refreshBefore } = input;
    const existing = await this.find(id);

    let verified =
      existing?.verified || (await this.isVerified(principal, url));
    if (!verified) {
      await this.verifyEndpoint(url, secret, id);
      verified = true;
    }
    const metadata = {
      principal,
      name,
      arguments: args,
      refreshBefore,
      verified,
    };

    if (!existing) {
      try {
        await this.hookgres.createEndpoint({
          tenantId: id,
          url,
          eventTypes: [name],
          secret,
          metadata,
        });
      } catch (error) {
        if (error instanceof HookgresValidationError) {
          throw invalid("delivery.url is not an allowed callback address");
        }
        throw error;
      }
      return {
        resultType: "complete",
        id,
        refreshBefore,
        cursor: null,
        truncated: false,
      };
    }

    if (existing.secret !== secret) {
      // Dual-sign with the old secret for a while, as the SEP recommends.
      await this.hookgres.rotateEndpointSecret(existing.endpointId, {
        secret,
        graceMs: 5 * 60_000,
      });
    }
    await this.hookgres.updateEndpoint(existing.endpointId, {
      metadata,
      ...(existing.disabled ? { disabled: false } : {}),
    });
    return {
      resultType: "complete",
      id,
      refreshBefore,
      cursor: null,
      truncated: false,
      deliveryStatus: await this.deliveryStatus(existing),
    };
  }

  private async unsubscribe(
    params: Record<string, unknown>,
    principal: string | null | undefined,
  ): Promise<Record<string, unknown>> {
    if (!principal) {
      throw new McpEventsError(McpEventsErrorCode.Forbidden, "Forbidden", {
        reason: "events/unsubscribe needs an authenticated principal",
      });
    }
    const { name, args, url } = this.keyParams(params);
    const id = subscriptionId(principal, url, name, args);
    return this.withKeyLock(id, async () => {
      const { rows } = await this.pool.query<{ id: string }>(
        `SELECT id FROM ${this.table} WHERE tenant_id = $1`,
        [id],
      );
      if (rows.length === 0) {
        throw new McpEventsError(McpEventsErrorCode.NotFound, "NotFound", {
          kind: "subscription",
        });
      }
      for (const row of rows) await this.hookgres.deleteEndpoint(row.id);
      return { resultType: "complete" };
    });
  }

  private keyParams(params: Record<string, unknown>) {
    const name = params.name;
    if (typeof name !== "string") throw invalid("name is required");
    if (!this.types.has(name)) {
      throw new McpEventsError(McpEventsErrorCode.NotFound, "NotFound", {
        kind: "event",
      });
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw invalid("arguments must be an object");
    }
    if (canonicalJson(args).length > MAX_ARGUMENTS_BYTES) {
      throw invalid(`arguments must be at most ${MAX_ARGUMENTS_BYTES} bytes`);
    }
    const delivery = params.delivery;
    if (typeof delivery !== "object" || delivery === null) {
      throw invalid("delivery is required");
    }
    const url = (delivery as Record<string, unknown>).url;
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      throw invalid("delivery.url must be an absolute https URL");
    }
    const httpOk = this.allowHttp && parsed.protocol === "http:";
    if (parsed.protocol !== "https:" && !httpOk) {
      throw invalid("delivery.url must use https");
    }
    return { name, args, url: String(url) };
  }

  private grant(ttlMs: unknown): string | null {
    if (ttlMs === null && this.allowNoExpiry) return null;
    const suggested =
      typeof ttlMs === "number" && Number.isFinite(ttlMs)
        ? ttlMs
        : this.ttl.defaultMs;
    const ms = Math.min(Math.max(suggested, this.ttl.minMs), this.ttl.maxMs);
    return new Date(Date.now() + ms).toISOString();
  }

  private async find(id: string): Promise<Subscription | null> {
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id, disabled, failing_since, secret, metadata
       FROM ${this.table} WHERE tenant_id = $1 LIMIT 1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      endpointId: row.id,
      id: row.tenant_id,
      disabled: row.disabled,
      failingSince: row.failing_since,
      secret: row.secret,
      refreshBefore: row.metadata.refreshBefore ?? null,
      verified: row.metadata.verified === true,
    };
  }

  /** Verification is cached per (principal, url), across arguments. */
  private async isVerified(principal: string, url: string): Promise<boolean> {
    if (typeof this.verifyMode === "function") return this.verifyMode(url);
    const { rows } = await this.pool.query(
      `SELECT 1 FROM ${this.table}
       WHERE url = $1 AND metadata->>'principal' = $2
         AND metadata->>'verified' = 'true' LIMIT 1`,
      [url, principal],
    );
    return rows.length > 0;
  }

  private async verifyEndpoint(url: string, secret: string, id: string) {
    if (typeof this.verifyMode === "function") {
      throw new McpEventsError(
        McpEventsErrorCode.CallbackEndpointError,
        "Callback URL is not allowed",
        { reason: "challenge_failed" },
      );
    }
    this.limitVerifications(new URL(url).hostname);
    const challenge = randomBytes(24).toString("base64url");
    const body = JSON.stringify({ type: "verification", challenge });
    const messageId = `msg_verification_${randomBytes(16).toString("hex")}`;
    const timestamp = Math.floor(Date.now() / 1000);
    let reason: string;
    try {
      const response = await this.transport.send(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": messageId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": sign(secret, messageId, timestamp, body),
          [SUBSCRIPTION_ID_HEADER]: id,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      const text = await readBounded(
        response.body,
        MAX_CHALLENGE_RESPONSE_BYTES,
      );
      if (response.status >= 200 && response.status < 300) {
        const echoed = parseChallenge(text);
        if (echoed !== null && safeEqual(echoed, challenge)) return;
        reason = "challenge_failed";
      } else {
        reason = response.status >= 500 ? "http_5xx" : "http_4xx";
      }
    } catch (error) {
      reason = errorCategory(error);
    }
    throw new McpEventsError(
      McpEventsErrorCode.CallbackEndpointError,
      "Callback endpoint failed verification",
      { reason },
    );
  }

  private limitVerifications(host: string) {
    const now = Date.now();
    const recent = (this.verificationLog.get(host) ?? []).filter(
      (at) => at > now - 60_000,
    );
    if (recent.length >= this.verificationLimit) {
      throw new McpEventsError(
        McpEventsErrorCode.ResourceExhausted,
        "Too many verification requests to this host",
        { limit: "verifications", max: this.verificationLimit },
      );
    }
    recent.push(now);
    this.verificationLog.set(host, recent);
  }

  private async deliveryStatus(sub: Subscription) {
    const { rows } = await this.pool.query<{
      last_success: Date | null;
      last_error: string | null;
    }>(
      `SELECT
         (SELECT max(updated_at) FROM "${this.schemaName()}".deliveries
          WHERE endpoint_id = $1 AND status = 'succeeded') AS last_success,
         (SELECT last_error FROM "${this.schemaName()}".deliveries
          WHERE endpoint_id = $1 AND last_error IS NOT NULL
          ORDER BY updated_at DESC LIMIT 1) AS last_error`,
      [sub.endpointId],
    );
    const row = rows[0];
    return {
      // false when delivery was suspended; this refresh has just resumed it.
      active: !sub.disabled,
      lastDeliveryAt: row?.last_success?.toISOString() ?? null,
      lastError:
        sub.failingSince && row?.last_error
          ? lastErrorCategory(row.last_error)
          : null,
      ...(sub.failingSince
        ? { failedSince: sub.failingSince.toISOString() }
        : {}),
    };
  }

  private schemaName(): string {
    return this.table.slice(1, this.table.indexOf('"', 1));
  }
}

/** Deterministic over (principal, url, name, arguments), per the SEP. */
export function subscriptionId(
  principal: string,
  url: string,
  name: string,
  args: Record<string, unknown>,
): string {
  const key = canonicalJson([principal, url, name, args]);
  return `sub_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Reads at most `limit` bytes of a body, then cancels the rest. */
async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (size > limit) return "";
  return Buffer.concat(chunks).toString("utf8");
}

function invalid(message: string): McpEventsError {
  return new McpEventsError(McpEventsErrorCode.InvalidParams, message);
}

function parseChallenge(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function errorCategory(error: unknown): string {
  const text = `${(error as Error)?.name ?? ""} ${(error as Error)?.message ?? ""} ${
    (error as { code?: string })?.code ?? ""
  }`;
  if (/timeout|abort/i.test(text)) return "timeout";
  if (/cert|tls|ssl|self.signed/i.test(text)) return "tls_error";
  return "connection_refused";
}

/** Maps Hookgres's `last_error` to the SEP's `lastError` categories. */
function lastErrorCategory(lastError: string): string {
  const status = /^HTTP (\d{3})/.exec(lastError)?.[1];
  if (status) return status.startsWith("5") ? "http_5xx" : "http_4xx";
  return errorCategory(new Error(lastError));
}
