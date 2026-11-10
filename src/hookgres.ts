import pg, { type QueryResult, type QueryResultRow } from "pg";
import { HookgresValidationError } from "./errors.js";
import { newId } from "./ids.js";
import { migrations } from "./migrations.js";
import { assertSecret, generateSecret, sign } from "./signing.js";
import {
  AddressGuard,
  type BlockPrivateAddressesOption,
  guardedTransport,
  type Transport,
  type TransportResponse,
} from "./ssrf.js";
import type {
  Attempt,
  AttemptEvent,
  CleanupOptions,
  CreateEndpointInput,
  DeleteMessagesFilter,
  Delivery,
  DeliveryStatus,
  DrainOptions,
  Endpoint,
  EndpointDisabledEvent,
  ListDeliveriesInput,
  Message,
  Queryable,
  SendInput,
  SendOptions,
  SendResult,
  UpdateEndpointInput,
  WebhookEnvelope,
} from "./types.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Default delay in ms before each retry: 5s, 5m, 30m, 2h, 5h, 10h, 10h, so 8
 * attempts over roughly 28 hours. Pass your own as `retrySchedule`.
 *
 * @example
 * // Same schedule, plus one more retry a day later
 * new Hookgres({ pool, retrySchedule: [...DEFAULT_RETRY_SCHEDULE, 24 * 60 * 60 * 1000] });
 *
 * @see https://hookgres.dev/docs/guides/retries
 */
export const DEFAULT_RETRY_SCHEDULE = [
  5 * SECOND,
  5 * MINUTE,
  30 * MINUTE,
  2 * HOUR,
  5 * HOUR,
  10 * HOUR,
  10 * HOUR,
];

/** Default and maximum for `responseBodyLimit`. */
const RESPONSE_BODY_LIMIT = 4096;

/** Time `drain()` allows on top of `requestTimeoutMs` for a batch's queries. */
const DRAIN_MARGIN_MS = SECOND;

/** Base URL for the docs links in error messages. */
const DOCS = "https://hookgres.dev/docs";

/**
 * Options for `new Hookgres(options)`. Pass either `pool` or
 * `connectionString`; everything else is optional.
 *
 * @example
 * import pg from "pg";
 * import { Hookgres } from "hookgres";
 *
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const hookgres = new Hookgres({
 *   pool,
 *   blockPrivateAddresses: true, // customer URLs can't reach internal hosts
 *   onError: (error) => logger.error(error),
 * });
 *
 * @see https://hookgres.dev/docs/reference/configuration
 */
export interface HookgresOptions {
  /**
   * An existing `pg.Pool`, usually the one your app already uses, so
   * `send()` can join your transactions. Hookgres never closes a pool it did
   * not create.
   */
  pool?: pg.Pool;
  /** Alternatively, a connection string; Hookgres creates and owns the pool. */
  connectionString?: string;
  /**
   * Postgres schema for Hookgres's tables: lowercase letters, digits and
   * underscores. Defaults to `hookgres`. Run `migrate()` once per schema.
   */
  schema?: string;
  /**
   * Delay in ms before each retry. Its length + 1 is the max attempt count.
   * Defaults to {@link DEFAULT_RETRY_SCHEDULE} (8 attempts over ~28 hours).
   * @see https://hookgres.dev/docs/guides/retries
   */
  retrySchedule?: number[];
  /**
   * Spreads each retry delay randomly by up to this fraction, so endpoints
   * that failed together don't get retried together. `0.1` turns a 60s delay
   * into 54s to 66s. `0` disables it. Must be between 0 and 1. Defaults to 0.1.
   */
  retryJitter?: number;
  /** Per-request timeout in ms. Defaults to 15s. */
  requestTimeoutMs?: number;
  /**
   * Disable an endpoint once its attempts have failed without a success for
   * this long. Defaults to 5 days. `null` never disables.
   */
  disableEndpointAfterMs?: number | null;
  /** How long the worker sleeps when there is nothing to do. Defaults to 1s. */
  pollIntervalMs?: number;
  /**
   * Wake workers in every process as soon as a webhook is queued, with
   * Postgres LISTEN/NOTIFY, instead of waiting up to `pollIntervalMs`. Each
   * started worker holds one pool connection for LISTEN. Leave it off behind
   * PgBouncer in transaction mode or other proxies that don't support LISTEN.
   * Polling keeps running either way. Defaults to `false`.
   * @see https://hookgres.dev/docs/guides/workers#instant-wake-up-with-listen-notify
   */
  notify?: boolean;
  /** Max deliveries the worker sends in parallel. Defaults to 10. */
  concurrency?: number;
  /**
   * How long a claimed delivery stays locked before another worker may
   * reclaim it (e.g. after a crash). Must exceed `requestTimeoutMs`.
   * Defaults to `requestTimeoutMs + 30s`.
   */
  lockTimeoutMs?: number;
  /** Grace period for the old secret after `rotateEndpointSecret`. Defaults to 24h. */
  secretRotationGraceMs?: number;
  /**
   * Clear a message's payload once every delivery of it has succeeded (or
   * right away when no endpoint matched), keeping the delivery log: status
   * codes, timings and errors. Payloads of failed deliveries are kept so they
   * can be replayed; `cleanup()` removes them later. A redacted message can't
   * be replayed. Defaults to `false`.
   * @see https://hookgres.dev/docs/guides/privacy
   */
  redactPayloads?: boolean;
  /**
   * How many characters of each receiver response body to store in the
   * attempt log, from 0 (store none) to 4096. Receivers control what they
   * send back, so lower it if their responses might contain personal data.
   * Defaults to 4096.
   * @see https://hookgres.dev/docs/guides/privacy
   */
  responseBodyLimit?: number;
  /**
   * Refuse to send to private, loopback, link-local and other internal
   * addresses. `true` blocks them all; `{ allow: ["10.1.2.0/24"] }` blocks
   * all except the listed IPs and CIDRs. Checked when endpoints are created
   * or updated (IP literals and `localhost`) and on every delivery, after
   * DNS. Defaults to `false`. With a custom `fetch`, only the create/update
   * check applies.
   * @see https://hookgres.dev/docs/guides/production#block-internal-addresses-ssrf
   */
  blockPrivateAddresses?: BlockPrivateAddressesOption;
  /**
   * Custom fetch, e.g. to send through a proxy. With `blockPrivateAddresses`,
   * endpoint URLs are still checked, but delivery uses this fetch as is.
   */
  fetch?: typeof fetch;
  /** `User-Agent` header sent with every webhook. Defaults to `Hookgres/0.1`. */
  userAgent?: string;
  /** Called for unexpected worker errors, and for idle-connection errors on a pool Hookgres created from `connectionString`. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
  /**
   * Called after every HTTP attempt, e.g. to record metrics. Runs inline in
   * the worker, so keep it fast. Errors it throws (or a promise it rejects)
   * are reported with `process.emitWarning` and never affect delivery.
   * @see https://hookgres.dev/docs/guides/production#metrics-and-tracing
   */
  onAttempt?: (event: AttemptEvent) => void;
  /** Called when Hookgres disables an endpoint after failing for `disableEndpointAfterMs`. Errors are handled like `onAttempt`'s. */
  onEndpointDisabled?: (event: EndpointDisabledEvent) => void;
}

interface ClaimedDelivery {
  id: string;
  lock_token: string;
  attempt_count: number;
  endpoint_id: string;
  tenant_id: string;
  message_id: string;
  event_type: string;
  payload: unknown;
  message_created_at: Date;
  /** Only possible when a replay raced a redaction. */
  redacted: boolean;
  url: string;
  secret: string;
  /** Only set while the rotation grace period is running. */
  previous_secret: string | null;
  disabled: boolean;
}

interface HttpResult {
  ok: boolean;
  statusCode: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number;
}

/**
 * Sends signed webhooks from Postgres, with retries, endpoint health, secret
 * rotation and replay.
 *
 * @example
 * const hookgres = new Hookgres({ pool });
 * await hookgres.migrate();
 * hookgres.start();
 * await hookgres.send({ tenantId: "acme", eventType: "invoice.paid", payload });
 *
 * @see https://hookgres.dev/docs/
 */
export class Hookgres {
  /**
   * The pool Hookgres queries: the one you passed in, or the one it created
   * from `connectionString`. Use it to open transactions for `send()`.
   */
  readonly pool: pg.Pool;
  private readonly ownsPool: boolean;
  private readonly schema: string;
  private readonly t: {
    endpoints: string;
    messages: string;
    deliveries: string;
    attempts: string;
    migrations: string;
  };
  private readonly retrySchedule: number[];
  private readonly retryJitter: number;
  private readonly requestTimeoutMs: number;
  private readonly disableEndpointAfterMs: number | null;
  private readonly pollIntervalMs: number;
  private readonly concurrency: number;
  private readonly lockTimeoutMs: number;
  private readonly secretRotationGraceMs: number;
  private readonly redactPayloads: boolean;
  private readonly responseBodyLimit: number;
  private readonly guard: AddressGuard | null;
  private readonly transport: Transport;
  private readonly closeTransport: () => void;
  private readonly userAgent: string;
  private readonly onError: (error: unknown) => void;
  private readonly onAttempt: HookgresOptions["onAttempt"];
  private readonly onEndpointDisabled: HookgresOptions["onEndpointDisabled"];
  /** NOTIFY channel, or `null` when `notify` is off. */
  private readonly channel: string | null;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private wakePending = false;
  private generation = 0;
  /** Ends the LISTEN connection or its reconnect wait, during stop(). */
  private stopListener: (() => void) | null = null;

  /**
   * Creates a Hookgres instance. Validates options and connects lazily: no
   * query runs until you call a method. Create one instance per process and
   * share it.
   *
   * Throws a `HookgresValidationError` if neither `pool` nor
   * `connectionString` is given, or an option is out of range.
   *
   * @example
   * const hookgres = new Hookgres({ pool }); // your app's pg.Pool
   * await hookgres.migrate();
   *
   * @see https://hookgres.dev/docs/reference/configuration
   */
  constructor(options: HookgresOptions) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else if (options.connectionString) {
      this.pool = new pg.Pool({ connectionString: options.connectionString });
      this.ownsPool = true;
    } else {
      throw new HookgresValidationError(
        `new Hookgres() needs either \`pool\` (your app's pg.Pool) or \`connectionString\`, e.g. new Hookgres({ pool }). See ${DOCS}/reference/configuration`,
      );
    }

    const schema = options.schema ?? "hookgres";
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
      throw new HookgresValidationError(
        `Invalid schema name "${schema}": use lowercase letters, digits and underscores (at most 63), or omit \`schema\` to use "hookgres". See ${DOCS}/reference/configuration`,
      );
    }
    this.schema = `"${schema}"`;
    this.t = {
      endpoints: `${this.schema}.endpoints`,
      messages: `${this.schema}.messages`,
      deliveries: `${this.schema}.deliveries`,
      attempts: `${this.schema}.attempts`,
      migrations: `${this.schema}.schema_migrations`,
    };

    this.retrySchedule = options.retrySchedule ?? DEFAULT_RETRY_SCHEDULE;
    if (this.retrySchedule.some((ms) => !Number.isFinite(ms) || ms < 0)) {
      throw new HookgresValidationError(
        `retrySchedule must contain non-negative numbers (delays in ms), e.g. [5000, 300000, 1800000]. See ${DOCS}/guides/retries`,
      );
    }
    this.retryJitter = options.retryJitter ?? 0.1;
    if (
      !Number.isFinite(this.retryJitter) ||
      this.retryJitter < 0 ||
      this.retryJitter > 1
    ) {
      throw new HookgresValidationError(
        `retryJitter must be a number between 0 and 1, e.g. 0.1 for +/-10% (0 disables jitter). See ${DOCS}/guides/retries`,
      );
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15 * SECOND;
    this.disableEndpointAfterMs =
      options.disableEndpointAfterMs === undefined
        ? 5 * DAY
        : options.disableEndpointAfterMs;
    this.pollIntervalMs = options.pollIntervalMs ?? SECOND;
    this.concurrency = Math.max(1, options.concurrency ?? 10);
    this.lockTimeoutMs =
      options.lockTimeoutMs ?? this.requestTimeoutMs + 30 * SECOND;
    if (this.lockTimeoutMs <= this.requestTimeoutMs) {
      throw new HookgresValidationError(
        `lockTimeoutMs (${this.lockTimeoutMs}) must be greater than requestTimeoutMs (${this.requestTimeoutMs}): raise lockTimeoutMs, or omit it to use requestTimeoutMs + 30s. See ${DOCS}/reference/configuration`,
      );
    }
    this.secretRotationGraceMs = options.secretRotationGraceMs ?? DAY;
    this.redactPayloads = options.redactPayloads ?? false;
    this.responseBodyLimit = options.responseBodyLimit ?? RESPONSE_BODY_LIMIT;
    if (
      !Number.isInteger(this.responseBodyLimit) ||
      this.responseBodyLimit < 0 ||
      this.responseBodyLimit > RESPONSE_BODY_LIMIT
    ) {
      throw new HookgresValidationError(
        `responseBodyLimit must be an integer from 0 (store no response bodies) to ${RESPONSE_BODY_LIMIT}. See ${DOCS}/guides/privacy`,
      );
    }
    this.guard = options.blockPrivateAddresses
      ? new AddressGuard(options.blockPrivateAddresses)
      : null;
    if (this.guard && !options.fetch) {
      const guarded = guardedTransport(this.guard);
      this.transport = guarded.send;
      this.closeTransport = guarded.close;
    } else {
      this.transport = options.fetch ?? globalThis.fetch;
      this.closeTransport = () => {};
      if (this.guard) {
        process.emitWarning(
          "blockPrivateAddresses with a custom fetch only checks endpoint URLs when they are created or updated. Checking the addresses each delivery connects to is up to your fetch or proxy (see isPrivateAddress, or a proxy like Smokescreen).",
          { code: "HOOKGRES_SSRF_CUSTOM_FETCH" },
        );
      }
    }
    this.userAgent = options.userAgent ?? "Hookgres/0.1";
    this.onError =
      options.onError ??
      ((error) => console.error("[hookgres] worker error:", error));
    // node-postgres emits "error" on the pool when an idle client's connection
    // drops; without a listener that crashes the process. A pool the caller
    // passed in is theirs to handle.
    if (this.ownsPool) this.pool.on("error", (error) => this.onError(error));
    this.onAttempt = options.onAttempt;
    this.onEndpointDisabled = options.onEndpointDisabled;
    // The listener holds a pool connection while the worker runs; with only
    // one, claims and sends would wait for it forever.
    if (options.notify && (this.pool.options?.max ?? 10) < 2) {
      throw new HookgresValidationError(
        `notify needs a pool with max of at least 2, because the worker holds one connection for LISTEN: raise the pool's \`max\` or turn \`notify\` off. See ${DOCS}/guides/workers#instant-wake-up-with-listen-notify`,
      );
    }
    // Postgres channel names are at most 63 bytes; pg_notify rejects longer.
    this.channel = options.notify ? `${schema}_wake`.slice(0, 63) : null;
  }

  // ---------------------------------------------------------------- schema

  /**
   * Creates or upgrades Hookgres's tables. Idempotent and safe to run
   * concurrently (it takes an advisory lock), so call it on every startup,
   * before any other method. If your app's database role can't `CREATE`, run
   * it from a deploy step with a role that can.
   *
   * @example
   * const hookgres = new Hookgres({ pool });
   * await hookgres.migrate();
   *
   * @see https://hookgres.dev/docs/reference/schema
   */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `hookgres:migrate:${this.schema}`,
      ]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.t.migrations} (
          version integer PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`,
      );
      const { rows } = await client.query<{ version: number }>(
        `SELECT version FROM ${this.t.migrations}`,
      );
      const applied = new Set(rows.map((r) => r.version));
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        await client.query(migration.sql.replaceAll("{{schema}}", this.schema));
        await client.query(
          `INSERT INTO ${this.t.migrations} (version) VALUES ($1)`,
          [migration.version],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------- endpoints

  /**
   * Registers a URL to receive a tenant's webhooks. Generates a `whsec_`
   * secret unless `input.secret` is given; show it to the tenant once.
   *
   * Take `tenantId` from the signed-in session, never from the request body.
   * Throws a `HookgresValidationError` for a non-http(s) URL, an invalid
   * event type pattern or secret, and, with `blockPrivateAddresses`, a
   * private or `localhost` URL: return it to the caller as a 400.
   *
   * @example
   * const endpoint = await hookgres.createEndpoint({
   *   tenantId: session.tenantId,
   *   url: "https://example.com/webhooks",
   *   eventTypes: ["invoice.paid", "customer.*"], // omit for every event type
   * });
   * return { id: endpoint.id, secret: endpoint.secret }; // show the secret once
   *
   * @see https://hookgres.dev/docs/guides/endpoints
   */
  async createEndpoint(input: CreateEndpointInput): Promise<Endpoint> {
    assertUrl(input.url, this.guard);
    const { rows } = await this.query(
      `INSERT INTO ${this.t.endpoints}
         (id, tenant_id, url, description, event_types, secret, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        newId("ep"),
        input.tenantId,
        input.url,
        input.description ?? null,
        normaliseEventTypes(input.eventTypes),
        input.secret === undefined
          ? generateSecret()
          : assertSecret(input.secret),
        input.metadata ?? {},
      ],
    );
    return toEndpoint(rows[0]);
  }

  /**
   * Returns the endpoint, or `null`. Includes its secret. Lookups are by id
   * only: check `endpoint.tenantId` against the signed-in tenant before
   * returning, updating, deleting or rotating it.
   *
   * @example
   * const endpoint = await hookgres.getEndpoint(id);
   * if (!endpoint || endpoint.tenantId !== session.tenantId) return notFound();
   *
   * @see https://hookgres.dev/docs/guides/endpoints
   */
  async getEndpoint(id: string): Promise<Endpoint | null> {
    const { rows } = await this.query(
      `SELECT * FROM ${this.t.endpoints} WHERE id = $1`,
      [id],
    );
    return rows[0] ? toEndpoint(rows[0]) : null;
  }

  /**
   * Returns all of a tenant's endpoints, oldest first, including disabled
   * ones and their secrets.
   *
   * @example
   * const endpoints = await hookgres.listEndpoints(session.tenantId);
   *
   * @see https://hookgres.dev/docs/guides/endpoints
   */
  async listEndpoints(tenantId: string): Promise<Endpoint[]> {
    const { rows } = await this.query(
      `SELECT * FROM ${this.t.endpoints} WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return rows.map(toEndpoint);
  }

  /**
   * Changes only the fields given. `disabled: false` re-enables an endpoint
   * and clears its failure state. Returns `null` if it doesn't exist.
   * Validates `url` and `eventTypes` like `createEndpoint`. Check the
   * endpoint's tenant with `getEndpoint` first.
   *
   * @example
   * await hookgres.updateEndpoint(endpoint.id, { eventTypes: null }); // all events
   * await hookgres.updateEndpoint(endpoint.id, { disabled: false }); // re-enable
   *
   * @see https://hookgres.dev/docs/guides/endpoints
   */
  async updateEndpoint(
    id: string,
    patch: UpdateEndpointInput,
  ): Promise<Endpoint | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.url !== undefined) {
      assertUrl(patch.url, this.guard);
      set("url", patch.url);
    }
    if (patch.description !== undefined) set("description", patch.description);
    if (patch.eventTypes !== undefined) {
      set("event_types", normaliseEventTypes(patch.eventTypes));
    }
    if (patch.metadata !== undefined) set("metadata", patch.metadata);
    if (patch.disabled !== undefined) {
      set("disabled", patch.disabled);
      if (patch.disabled) {
        set("disabled_reason", "Disabled manually");
      } else {
        sets.push("disabled_reason = NULL", "failing_since = NULL");
      }
    }
    if (sets.length === 0) return this.getEndpoint(id);
    values.push(id);
    const { rows } = await this.query(
      `UPDATE ${this.t.endpoints}
       SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${values.length}
       RETURNING *`,
      values,
    );
    return rows[0] ? toEndpoint(rows[0]) : null;
  }

  /**
   * Deletes an endpoint together with its deliveries and attempts. Returns
   * `false` if it didn't exist. Check the endpoint's tenant with
   * `getEndpoint` first.
   *
   * @example
   * const deleted = await hookgres.deleteEndpoint(endpoint.id);
   *
   * @see https://hookgres.dev/docs/guides/endpoints
   */
  async deleteEndpoint(id: string): Promise<boolean> {
    const { rowCount } = await this.query(
      `DELETE FROM ${this.t.endpoints} WHERE id = $1`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Replaces the signing secret. Deliveries are signed with both the new and
   * the old secret until the grace period ends, so receivers can roll over.
   * Only one previous secret is kept: rotating again ends the earlier grace
   * period immediately. Returns `null` if the endpoint doesn't exist. Show
   * the new `endpoint.secret` to the tenant once.
   *
   * @example
   * const rotated = await hookgres.rotateEndpointSecret(endpoint.id, {
   *   graceMs: 24 * 60 * 60 * 1000, // old secret keeps working for 24h
   * });
   *
   * @see https://hookgres.dev/docs/guides/secret-rotation
   */
  async rotateEndpointSecret(
    id: string,
    options: { secret?: string; graceMs?: number } = {},
  ): Promise<Endpoint | null> {
    const graceMs = options.graceMs ?? this.secretRotationGraceMs;
    const { rows } = await this.query(
      `UPDATE ${this.t.endpoints}
       SET previous_secret = secret,
           previous_secret_expires_at = now() + make_interval(secs => $2::double precision / 1000),
           secret = $3,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        graceMs,
        options.secret === undefined
          ? generateSecret()
          : assertSecret(options.secret),
      ],
    );
    return rows[0] ? toEndpoint(rows[0]) : null;
  }

  // -------------------------------------------------------------- messages

  /**
   * Queues a webhook for every enabled endpoint of the tenant subscribed to
   * `eventType`. The message and its deliveries are written in one atomic
   * statement.
   *
   * To queue the webhook only if your own changes commit, pass the client of
   * your transaction as `options.client`. Without it, `send()` runs on the
   * pool, outside your transaction, and is queued even if you roll back.
   *
   * A tenant with no matching endpoints is not an error: the message is
   * stored and `deliveryCount` is 0. Sending again with the same
   * `idempotencyKey` returns the original message with `deduplicated: true`.
   * Delivery happens later, in a worker (`start()`, `runOnce()` or
   * `drain()`). Throws a `HookgresValidationError` for an event type with
   * `*`, a missing payload, or a payload containing `\u0000` (through
   * `fromPrisma`, that last one arrives as Prisma's own error).
   *
   * @example
   * const client = await pool.connect();
   * try {
   *   await client.query("BEGIN");
   *   await client.query("UPDATE invoices SET paid = true WHERE id = $1", [id]);
   *   await hookgres.send(
   *     { tenantId, eventType: "invoice.paid", payload: { id }, idempotencyKey: `invoice.paid:${id}` },
   *     { client }, // same transaction: queued only if it commits
   *   );
   *   await client.query("COMMIT");
   * } catch (error) {
   *   await client.query("ROLLBACK");
   *   throw error;
   * } finally {
   *   client.release();
   * }
   *
   * @see https://hookgres.dev/docs/guides/sending
   */
  async send(input: SendInput, options: SendOptions = {}): Promise<SendResult> {
    const db: Queryable = options.client ?? this.pool;
    if (input.eventType.includes("*")) {
      throw new HookgresValidationError(
        `Invalid event type "${input.eventType}": "*" is only allowed in an endpoint's eventTypes. Send one concrete event type like "invoice.paid"; endpoints subscribe to groups with "invoice.*". See ${DOCS}/guides/sending`,
      );
    }
    if (input.payload === undefined) {
      throw new HookgresValidationError(
        `send() requires a JSON-serialisable payload: pass the event data as \`payload\` (use null or {} for none). See ${DOCS}/guides/sending`,
      );
    }
    const payload = JSON.stringify(input.payload);
    const idempotencyKey = input.idempotencyKey ?? null;
    const values = [
      newId("msg"),
      input.tenantId,
      input.eventType,
      payload,
      idempotencyKey,
    ];
    // NOTIFY is transactional: it goes out when the caller's transaction
    // commits, and not at all on rollback.
    let notify = "";
    if (this.channel) {
      values.push(this.channel);
      notify = `, n AS (SELECT pg_notify($6, '') FROM (SELECT 1 FROM d LIMIT 1) x)`;
    }

    const { rows } = await withNulHint(
      this.query(
        `WITH m AS (
         INSERT INTO ${this.t.messages} (id, tenant_id, event_type, payload, idempotency_key)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING *
       ), d AS (
         INSERT INTO ${this.t.deliveries} (message_id, endpoint_id)
         SELECT m.id, e.id
         FROM m
         JOIN ${this.t.endpoints} e
           ON e.tenant_id = m.tenant_id
          AND NOT e.disabled
          AND (
            e.event_types IS NULL
            OR m.event_type = ANY (e.event_types)
            -- "invoice.*" matches any event type starting with "invoice."
            OR EXISTS (
              SELECT 1 FROM unnest(e.event_types) AS p (pattern)
              WHERE right(p.pattern, 2) = '.*'
                AND starts_with(m.event_type, left(p.pattern, -1))
            )
          )
         RETURNING 1
       )${notify}
       SELECT m.*, (SELECT count(*) FROM d)::int AS delivery_count
              ${notify ? ", (SELECT count(*) FROM n) AS notified" : ""}
       FROM m`,
        values,
        db,
      ),
    );

    if (rows[0]) {
      // Inside a caller's transaction the rows aren't visible until commit, so
      // waking now would find nothing; the next poll picks them up.
      if (!options.client) this.wake();
      let row = rows[0];
      if (this.redactPayloads && row.delivery_count === 0) {
        const redacted = await this.redact(row.id, db);
        if (redacted) row = { ...row, ...redacted };
      }
      return {
        message: toMessage(row),
        deliveryCount: rows[0].delivery_count,
        deduplicated: false,
      };
    }

    // Idempotency key already used: return the original message.
    const existing = await this.query(
      `SELECT m.*,
              (SELECT count(*) FROM ${this.t.deliveries} d WHERE d.message_id = m.id)::int AS delivery_count
       FROM ${this.t.messages} m
       WHERE m.tenant_id = $1 AND m.idempotency_key = $2`,
      [input.tenantId, idempotencyKey],
      db,
    );
    const row = existing.rows[0];
    if (!row) {
      throw new Error(
        "The message for this idempotencyKey was deleted while send() ran (e.g. by cleanup()); retry send()",
      );
    }
    return {
      message: toMessage(row),
      deliveryCount: row.delivery_count,
      deduplicated: true,
    };
  }

  /**
   * Returns the message (the event as sent, with its payload), or `null`.
   * With `redactPayloads`, `payload` is `null` once `redactedAt` is set.
   * Lookups are by id only: check `message.tenantId` before showing it.
   *
   * @example
   * const message = await hookgres.getMessage(result.message.id);
   */
  async getMessage(id: string): Promise<Message | null> {
    const { rows } = await this.query(
      `SELECT * FROM ${this.t.messages} WHERE id = $1`,
      [id],
    );
    return rows[0] ? toMessage(rows[0]) : null;
  }

  /**
   * Deletes messages created before `olderThan` whose deliveries are all
   * finished (none `pending` or `delivering`), with their deliveries and
   * attempts. Works in batches of `batchSize` (default 1000) until none are
   * left, and returns how many messages it deleted. Run it from a daily job.
   *
   * @example
   * const thirtyDays = 30 * 24 * 60 * 60 * 1000;
   * const deleted = await hookgres.cleanup({ olderThan: thirtyDays });
   *
   * @see https://hookgres.dev/docs/guides/production#clean-up-old-rows
   */
  async cleanup(options: CleanupOptions): Promise<number> {
    const { olderThan } = options;
    const batchSize = options.batchSize ?? 1000;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new HookgresValidationError(
        `cleanup batchSize must be a positive integer, e.g. 1000 (the default). See ${DOCS}/guides/production#clean-up-old-rows`,
      );
    }
    let cutoff: Date;
    if (olderThan instanceof Date) {
      if (Number.isNaN(olderThan.getTime())) {
        throw new HookgresValidationError(
          `cleanup olderThan is an invalid Date: pass a valid Date, or an age in ms like 30 * 24 * 60 * 60 * 1000. See ${DOCS}/guides/production#clean-up-old-rows`,
        );
      }
      cutoff = olderThan;
    } else if (Number.isFinite(olderThan) && olderThan >= 0) {
      // Use the database clock, like every other timestamp Hookgres writes.
      const { rows } = await this.query<{ cutoff: Date }>(
        "SELECT now() - make_interval(secs => $1::double precision / 1000) AS cutoff",
        [olderThan],
      );
      cutoff = (rows[0] as { cutoff: Date }).cutoff;
    } else {
      throw new HookgresValidationError(
        `cleanup olderThan must be a Date or a non-negative number of ms, e.g. { olderThan: 30 * 24 * 60 * 60 * 1000 } for 30 days. See ${DOCS}/guides/production#clean-up-old-rows`,
      );
    }

    let deleted = 0;
    for (;;) {
      const { rowCount } = await this.query(
        `DELETE FROM ${this.t.messages}
         WHERE id IN (
           SELECT m.id FROM ${this.t.messages} m
           WHERE m.created_at < $1
             AND NOT EXISTS (
               SELECT 1 FROM ${this.t.deliveries} d
               WHERE d.message_id = m.id AND d.status IN ('pending', 'delivering')
             )
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )`,
        [cutoff, batchSize],
      );
      deleted += rowCount ?? 0;
      if ((rowCount ?? 0) < batchSize) return deleted;
    }
  }

  /**
   * Deletes the messages that match every filter given, with their
   * deliveries and attempts, whatever their status, and returns how many it
   * deleted. Use it for erasure requests and to offboard a tenant. Pending
   * deliveries of a deleted message are never sent; one already in flight
   * may still arrive. Deleting a message frees its idempotency key.
   *
   * Throws a `HookgresValidationError` when no filter is given, so it can't
   * delete everything by accident. Endpoints are not deleted: use
   * `deleteEndpoint` for those.
   *
   * @example
   * // A person asks to be forgotten
   * const deleted = await hookgres.deleteMessages({
   *   tenantId: "acme",
   *   payloadContains: { userId: "usr_123" },
   * });
   *
   * @see https://hookgres.dev/docs/guides/privacy
   */
  async deleteMessages(filter: DeleteMessagesFilter): Promise<number> {
    const { tenantId, messageIds, payloadContains } = filter;
    const batchSize = filter.batchSize ?? 1000;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new HookgresValidationError(
        `deleteMessages batchSize must be a positive integer, e.g. 1000 (the default). See ${DOCS}/guides/privacy`,
      );
    }
    if (
      tenantId === undefined &&
      messageIds === undefined &&
      payloadContains === undefined
    ) {
      throw new HookgresValidationError(
        `deleteMessages needs at least one filter: tenantId, messageIds or payloadContains, e.g. { tenantId: "acme", payloadContains: { userId: "usr_123" } }. See ${DOCS}/guides/privacy`,
      );
    }
    if (
      payloadContains !== undefined &&
      (payloadContains === null || typeof payloadContains !== "object")
    ) {
      throw new HookgresValidationError(
        `deleteMessages payloadContains must be a JSON object or array, e.g. { userId: "usr_123" }. See ${DOCS}/guides/privacy`,
      );
    }
    if (messageIds?.length === 0) return 0;

    const where: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace("?", `$${values.length}`));
    };
    if (tenantId !== undefined) add("tenant_id = ?", tenantId);
    if (messageIds !== undefined) add("id = ANY (?::text[])", messageIds);
    if (payloadContains !== undefined) {
      add("payload @> ?::jsonb", JSON.stringify(payloadContains));
    }
    values.push(batchSize);

    let deleted = 0;
    // Until a batch finds nothing: stopping at a short batch could leave rows
    // behind when something else deleted part of it concurrently.
    for (;;) {
      const { rowCount } = await this.query(
        `DELETE FROM ${this.t.messages}
         WHERE id IN (
           SELECT id FROM ${this.t.messages}
           WHERE ${where.join(" AND ")}
           LIMIT $${values.length}
         )`,
        values,
      );
      if (!rowCount) return deleted;
      deleted += rowCount;
    }
  }

  // ------------------------------------------------------------ deliveries

  /**
   * Returns the delivery (one message to one endpoint), or `null`. Its
   * `status` is `pending`, `delivering`, `succeeded` or `failed`.
   *
   * @example
   * const delivery = await hookgres.getDelivery(deliveryId);
   * if (delivery?.status === "failed") console.log(delivery.lastError);
   */
  async getDelivery(id: string): Promise<Delivery | null> {
    const { rows } = await this.query(
      `SELECT * FROM ${this.t.deliveries} WHERE id = $1`,
      [id],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  /**
   * Lists deliveries newest first, filtered by message, endpoint or status.
   * `limit` defaults to 50 and is capped at 500. Filter by an endpoint whose
   * tenant you checked to show a tenant its delivery log.
   *
   * @example
   * const failed = await hookgres.listDeliveries({
   *   endpointId: endpoint.id,
   *   status: "failed",
   *   limit: 20,
   * });
   */
  async listDeliveries(input: ListDeliveriesInput = {}): Promise<Delivery[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace("?", `$${values.length}`));
    };
    if (input.messageId) add("message_id = ?", input.messageId);
    if (input.endpointId) add("endpoint_id = ?", input.endpointId);
    if (input.status) add("status = ?", input.status);
    values.push(Math.min(Math.max(1, input.limit ?? 50), 500));
    const { rows } = await this.query(
      `SELECT * FROM ${this.t.deliveries}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id
       LIMIT $${values.length}`,
      values,
    );
    return rows.map(toDelivery);
  }

  /**
   * Lists every HTTP attempt of a delivery, oldest first, with status code,
   * the start of the response body (see `responseBodyLimit`), error and
   * duration.
   *
   * @example
   * const attempts = await hookgres.listAttempts(delivery.id);
   */
  async listAttempts(deliveryId: string): Promise<Attempt[]> {
    const { rows } = await this.query(
      `SELECT * FROM ${this.t.attempts} WHERE delivery_id = $1 ORDER BY created_at, attempt_number`,
      [deliveryId],
    );
    return rows.map(toAttempt);
  }

  /**
   * Re-queues a finished delivery (succeeded or failed) for immediate sending
   * with a fresh retry schedule. Returns `null` if the delivery does not exist
   * or is still in flight (`pending` or `delivering`), and throws a
   * `HookgresValidationError` if its message's payload was redacted
   * (`redactPayloads`). The original message
   * id is kept, so receivers that deduplicate on `webhook-id` will skip it.
   * A worker must be running (or `runOnce()` called) to send it.
   *
   * @example
   * const replayed = await hookgres.replayDelivery(delivery.id);
   * if (!replayed) throw new Error("Not found or still in flight");
   *
   * @see https://hookgres.dev/docs/guides/retries
   */
  async replayDelivery(id: string): Promise<Delivery | null> {
    const update = `UPDATE ${this.t.deliveries}
       SET status = 'pending', attempt_count = 0, next_attempt_at = now(),
           locked_until = NULL, lock_token = NULL, last_error = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('succeeded', 'failed')
         -- Blocks cleanup() from deleting the message under this replay.
         AND EXISTS (
           SELECT 1 FROM ${this.t.messages} m
           WHERE m.id = message_id AND m.redacted_at IS NULL
           FOR SHARE
         )
       RETURNING *`;
    const { rows } = this.channel
      ? await this.query(
          `WITH r AS (${update})
           SELECT r.*, pg_notify($2, '') FROM r`,
          [id, this.channel],
        )
      : await this.query(update, [id]);
    if (!rows[0]) {
      const { rowCount } = await this.query(
        `SELECT 1 FROM ${this.t.deliveries} d
         JOIN ${this.t.messages} m ON m.id = d.message_id
         WHERE d.id = $1 AND m.redacted_at IS NOT NULL`,
        [id],
      );
      if (rowCount) {
        throw new HookgresValidationError(
          `Delivery ${id} can't be replayed: its message's payload was redacted (redactPayloads). Send the event again with send() instead. See ${DOCS}/guides/privacy`,
        );
      }
      return null;
    }
    this.wake();
    return toDelivery(rows[0]);
  }

  // ---------------------------------------------------------------- worker

  /**
   * Starts the background delivery loop in this process and returns
   * immediately. Calling it while already running does nothing; calling it
   * after `stop()` starts a new loop.
   *
   * Only use it in a long-running process (server or worker). On serverless
   * platforms the loop is frozen between requests: call `drain()` from a
   * cron route instead. Errors in the loop go to `onError` and never stop it.
   *
   * @example
   * hookgres.start();
   * process.on("SIGTERM", async () => {
   *   await hookgres.stop(); // let in-flight deliveries finish
   *   await pool.end();
   * });
   *
   * @see https://hookgres.dev/docs/guides/workers
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const previous = this.loopPromise;
    const active = () => this.running && generation === this.generation;
    this.loopPromise = (async () => {
      // If a stop() is still draining, let the old loop finish first.
      await previous;
      await Promise.all([
        this.loop(active),
        this.channel ? this.listen(this.channel, active) : null,
      ]);
    })();
  }

  /**
   * Stops the loop, closes the LISTEN connection (with `notify`) and waits
   * for in-flight deliveries to finish. Safe to call when not running. Does
   * not close the pool: call it before `pool.end()`, or use `close()`.
   *
   * @example
   * process.on("SIGTERM", async () => {
   *   await hookgres.stop();
   *   await pool.end();
   * });
   *
   * @see https://hookgres.dev/docs/guides/workers
   */
  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    this.stopListener?.();
    const loop = this.loopPromise;
    await loop;
    if (this.loopPromise === loop) this.loopPromise = null;
  }

  /**
   * Stops the worker (like `stop()`) and closes the pool if Hookgres created
   * it from `connectionString`. A pool you passed in stays open.
   *
   * @example
   * await hookgres.close();
   */
  async close(): Promise<void> {
    await this.stop();
    this.closeTransport();
    if (this.ownsPool) await this.pool.end();
  }

  /**
   * Claims and sends one batch (up to `concurrency`) of due deliveries,
   * then returns how many it processed. Use it from a cron or serverless
   * function instead of `start()`, usually through `drain()`, which calls it
   * until the queue is empty or time runs out. Always waits for every claimed
   * delivery to finish. Safe to run from several processes at once.
   *
   * @example
   * // Deliver right after the response, without waiting for the cron
   * after(() => hookgres.runOnce());
   *
   * @see https://hookgres.dev/docs/guides/workers
   */
  async runOnce(): Promise<number> {
    const claimed = await this.claim();
    const results = await Promise.allSettled(
      claimed.map((delivery) =>
        this.process(delivery).catch((error) => this.onError(error)),
      ),
    );
    // Only reachable when a custom onError rethrows.
    const failure = results.find((r) => r.status === "rejected");
    if (failure) throw (failure as PromiseRejectedResult).reason;
    return claimed.length;
  }

  /**
   * Calls `runOnce()` until a batch finds nothing due, or until another batch
   * might not finish within `timeoutMs`, and returns how many deliveries it
   * processed in total. Use it from a cron route or scheduled function on
   * serverless platforms, with `timeoutMs` a few seconds below the
   * function's time limit.
   *
   * A batch can take up to `requestTimeoutMs` (15s by default) when a
   * receiver is slow, so `drain()` only starts a batch while at least that
   * much time is left, plus a margin for the database queries (1s, or the
   * slowest batch so far if that took longer). Throws a
   * `HookgresValidationError` if `timeoutMs` is shorter than that, since no
   * batch could run. If `runOnce()` throws (only when a custom `onError`
   * rethrows), `drain()` rethrows it.
   *
   * @example
   * // app/api/cron/webhooks/route.ts, called by a cron every minute
   * export const maxDuration = 60;
   *
   * export async function GET() {
   *   const delivered = await hookgres.drain({ timeoutMs: 50_000 });
   *   return Response.json({ delivered });
   * }
   *
   * @see https://hookgres.dev/docs/guides/workers#cron-or-serverless
   */
  async drain(options: DrainOptions): Promise<number> {
    const { timeoutMs } = options;
    const minimum = this.requestTimeoutMs + DRAIN_MARGIN_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < minimum) {
      throw new HookgresValidationError(
        `drain() timeoutMs must be at least requestTimeoutMs + 1s (${minimum}ms), because one batch can take up to requestTimeoutMs: raise timeoutMs, or lower requestTimeoutMs. See ${DOCS}/guides/workers#cron-or-serverless`,
      );
    }
    const deadline = performance.now() + timeoutMs;
    let batchBudget = minimum;
    let total = 0;
    // The first batch always fits: timeoutMs >= minimum.
    for (;;) {
      const batchStarted = performance.now();
      const processed = await this.runOnce();
      total += processed;
      if (processed === 0) return total;
      const finished = performance.now();
      batchBudget = Math.max(batchBudget, finished - batchStarted);
      if (finished + batchBudget > deadline) return total;
    }
  }

  private async loop(active: () => boolean): Promise<void> {
    while (active()) {
      let processed = 0;
      try {
        processed = await this.runOnce();
      } catch (error) {
        this.reportError(error);
      }
      if (active() && processed < this.concurrency) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  /**
   * Runs a query on the pool, or on `db`. If Hookgres's tables don't exist,
   * adds to the error that `migrate()` hasn't been run.
   */
  private async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
    db: Queryable = this.pool,
  ): Promise<QueryResult<R>> {
    try {
      return await db.query<R>(text, values);
    } catch (error) {
      throw explainMissingTables(error, this.schema);
    }
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // A throwing onError must not kill the loop or the listener.
    }
  }

  /**
   * Holds one connection that LISTENs on the wake-up channel and wakes the
   * loop on every notification. If the connection drops, reconnects with
   * backoff (0.5s doubling to 30s); polling keeps delivering meanwhile.
   */
  private async listen(channel: string, active: () => boolean): Promise<void> {
    let failures = 0;
    while (active()) {
      let client: pg.PoolClient | undefined;
      let lost: unknown;
      try {
        client = await this.pool.connect();
        const c = client;
        const closed = new Promise<unknown>((resolve) => {
          // Without an "error" listener, a dropped connection would crash
          // the process.
          c.on("error", resolve);
          c.on("end", () => resolve(new Error("connection ended")));
          this.stopListener = () => resolve(undefined);
        });
        // stop() may have run while we were connecting.
        if (active()) {
          c.on("notification", () => this.wake());
          await c.query(`LISTEN "${channel}"`);
          failures = 0;
          // Catch up on anything queued while we weren't listening.
          this.wake();
          lost = await closed;
        }
      } catch (error) {
        lost = error;
      } finally {
        this.stopListener = null;
        // Destroy rather than return it: a pooled connection must not keep
        // listening.
        client?.release(true);
      }
      if (!active()) return;
      this.reportError(
        new Error("Hookgres LISTEN connection lost; reconnecting", {
          cause: lost,
        }),
      );
      failures++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          done,
          Math.min(30 * SECOND, 250 * 2 ** failures),
        );
        const self = this;
        function done() {
          clearTimeout(timer);
          self.stopListener = null;
          resolve();
        }
        this.stopListener = done;
      });
    }
  }

  /** Calls a user hook. Its errors never reach the delivery code. */
  private callHook<E>(
    name: string,
    hook: ((event: E) => void) | undefined,
    event: E,
  ): void {
    if (!hook) return;
    const warn = (error: unknown) => {
      let detail: string;
      try {
        detail = error instanceof Error ? error.message : String(error);
      } catch {
        detail = "unprintable error";
      }
      process.emitWarning(`Hookgres ${name} hook threw: ${detail}`, {
        code: "HOOKGRES_HOOK_ERROR",
      });
    };
    try {
      const result: unknown = hook(event);
      // Any thenable, so a rejected promise from another realm or library
      // can't become an unhandled rejection.
      const then = (result as { then?: unknown } | null)?.then;
      if (typeof then === "function") {
        then.call(result, undefined, warn);
      }
    } catch (error) {
      warn(error);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.wakePending) {
      this.wakePending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wakeUp === done) self.wakeUp = null;
        self.wakePending = false;
        resolve();
      }
      this.wakeUp = done;
    });
  }

  private wake(): void {
    if (this.wakeUp) this.wakeUp();
    else if (this.running) this.wakePending = true;
  }

  /**
   * Clears the message's payload if all its deliveries have succeeded (or it
   * has none). Returns the new columns, or `null` if nothing changed.
   */
  private async redact(
    messageId: string,
    db: Queryable = this.pool,
  ): Promise<{ payload: null; redacted_at: Date } | null> {
    const { rows } = await this.query<{ payload: null; redacted_at: Date }>(
      `UPDATE ${this.t.messages} m
       SET payload = NULL, redacted_at = now()
       WHERE m.id = $1 AND m.redacted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ${this.t.deliveries} d
           WHERE d.message_id = m.id AND d.status <> 'succeeded'
         )
       RETURNING m.payload, m.redacted_at`,
      [messageId],
      db,
    );
    return rows[0] ?? null;
  }

  private async claim(): Promise<ClaimedDelivery[]> {
    const { rows } = await this.query<ClaimedDelivery>(
      `WITH due AS (
         SELECT id FROM ${this.t.deliveries}
         WHERE (status = 'pending' AND next_attempt_at <= now())
            OR (status = 'delivering' AND locked_until < now())
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ${this.t.deliveries} d
       SET status = 'delivering',
           locked_until = now() + make_interval(secs => $2::double precision / 1000),
           lock_token = gen_random_uuid(),
           attempt_count = d.attempt_count + 1,
           updated_at = now()
       FROM due, ${this.t.messages} m, ${this.t.endpoints} e
       WHERE d.id = due.id AND m.id = d.message_id AND e.id = d.endpoint_id
       RETURNING d.id, d.lock_token, d.attempt_count, d.endpoint_id,
                 m.tenant_id, m.id AS message_id,
                 m.event_type, m.payload, m.created_at AS message_created_at,
                 m.redacted_at IS NOT NULL AS redacted,
                 e.url, e.secret,
                 CASE WHEN e.previous_secret_expires_at > now()
                      THEN e.previous_secret END AS previous_secret,
                 e.disabled`,
      [this.concurrency, this.lockTimeoutMs],
    );
    return rows;
  }

  /** Marks a claimed delivery failed without sending it. */
  private async failWithoutSending(
    delivery: ClaimedDelivery,
    reason: string,
  ): Promise<void> {
    await this.query(
      `UPDATE ${this.t.deliveries}
       SET status = 'failed', locked_until = NULL, lock_token = NULL,
           last_error = $3, updated_at = now()
       WHERE id = $1 AND lock_token = $2`,
      [delivery.id, delivery.lock_token, reason],
    );
  }

  private async process(delivery: ClaimedDelivery): Promise<void> {
    if (delivery.disabled) {
      await this.failWithoutSending(delivery, "Endpoint is disabled");
      return;
    }
    if (delivery.redacted) {
      await this.failWithoutSending(delivery, "Payload was redacted");
      return;
    }
    // A reclaimed delivery (its worker died mid-attempt) can exceed the limit.
    if (delivery.attempt_count > this.retrySchedule.length + 1) {
      await this.failWithoutSending(
        delivery,
        "Exceeded max attempts (worker stopped during the last attempt)",
      );
      return;
    }

    const outcome = await this.attempt(delivery);
    const attemptNumber = delivery.attempt_count;
    // Postgres text can't hold NUL; binary response bodies would make the
    // write fail and the delivery re-send forever.
    const responseBody = outcome.responseBody?.replaceAll("\u0000", "") ?? null;
    const event = {
      deliveryId: delivery.id,
      messageId: delivery.message_id,
      endpointId: delivery.endpoint_id,
      tenantId: delivery.tenant_id,
      eventType: delivery.event_type,
      attemptNumber,
      statusCode: outcome.statusCode,
      error: outcome.error,
      durationMs: outcome.durationMs,
    };

    // Each write only applies while this worker still holds the claim
    // (lock_token), so a stale worker can't overwrite a newer result. Hooks
    // only fire for results that were written.
    if (outcome.ok) {
      const { rowCount } = await this.query(
        `WITH d AS (
           UPDATE ${this.t.deliveries}
           SET status = 'succeeded', locked_until = NULL, lock_token = NULL,
               last_error = NULL, updated_at = now()
           WHERE id = $1 AND lock_token = $2
           RETURNING id, endpoint_id
         ), a AS (
           INSERT INTO ${this.t.attempts}
             (delivery_id, attempt_number, status_code, response_body, error, duration_ms)
           SELECT d.id, $3, $4, $5, NULL, $6 FROM d
         ), e AS (
           UPDATE ${this.t.endpoints}
           SET failing_since = NULL, updated_at = now()
           WHERE id IN (SELECT endpoint_id FROM d) AND failing_since IS NOT NULL
         )
         SELECT 1 FROM d`,
        [
          delivery.id,
          delivery.lock_token,
          attemptNumber,
          outcome.statusCode,
          responseBody,
          outcome.durationMs,
        ],
      );
      if (rowCount) {
        this.callHook<AttemptEvent>("onAttempt", this.onAttempt, {
          ...event,
          outcome: "succeeded",
          nextAttemptAt: null,
        });
        // A separate statement, after the success above committed: of two
        // last deliveries succeeding at once, the later one sees both.
        if (this.redactPayloads) await this.redact(delivery.message_id);
      }
      return;
    }

    const isFinal = attemptNumber > this.retrySchedule.length;
    const baseDelayMs = isFinal
      ? 0
      : (this.retrySchedule[attemptNumber - 1] ?? 0);
    const delayMs = Math.round(
      baseDelayMs * (1 + this.retryJitter * (2 * Math.random() - 1)),
    );
    const { rows } = await this.query<{
      next_attempt_at: Date;
      disabled_now: boolean | null;
      disabled_reason: string | null;
    }>(
      `WITH d AS (
         UPDATE ${this.t.deliveries}
         SET status = CASE WHEN $8::boolean THEN 'failed' ELSE 'pending' END,
             next_attempt_at = now() + make_interval(secs => $9::double precision / 1000),
             locked_until = NULL,
             lock_token = NULL,
             last_error = $6,
             updated_at = now()
         WHERE id = $1 AND lock_token = $2
         RETURNING id, endpoint_id, next_attempt_at
       ), a AS (
         INSERT INTO ${this.t.attempts}
           (delivery_id, attempt_number, status_code, response_body, error, duration_ms)
         SELECT d.id, $3, $4, $5, $6, $7 FROM d
       ), prev AS (
         -- Locks the endpoint and reads whether it was already disabled, so
         -- only the worker that disables it reports it.
         SELECT ep.id AS endpoint_id, ep.disabled AS was_disabled
         FROM ${this.t.endpoints} ep
         WHERE ep.id IN (SELECT endpoint_id FROM d)
         FOR UPDATE
       ), e AS (
       UPDATE ${this.t.endpoints}
       SET failing_since = COALESCE(failing_since, now()),
           disabled = disabled OR (
             $10::double precision IS NOT NULL AND
             COALESCE(failing_since, now()) <= now() - make_interval(secs => $10::double precision / 1000)
           ),
           disabled_reason = CASE
             WHEN NOT disabled AND $10::double precision IS NOT NULL AND
                  COALESCE(failing_since, now()) <= now() - make_interval(secs => $10::double precision / 1000)
             THEN 'Disabled automatically: every attempt failed since ' ||
                  to_char(COALESCE(failing_since, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
             ELSE disabled_reason
           END,
           updated_at = now()
       FROM prev
       WHERE id = prev.endpoint_id
       RETURNING disabled AND NOT prev.was_disabled AS disabled_now,
                 disabled_reason
       )
       SELECT d.next_attempt_at, e.disabled_now, e.disabled_reason
       FROM d LEFT JOIN e ON true`,
      [
        delivery.id,
        delivery.lock_token,
        attemptNumber,
        outcome.statusCode,
        responseBody,
        outcome.error ?? `HTTP ${outcome.statusCode}`,
        outcome.durationMs,
        isFinal,
        delayMs,
        this.disableEndpointAfterMs,
      ],
    );
    const result = rows[0];
    if (!result) return;
    this.callHook<AttemptEvent>("onAttempt", this.onAttempt, {
      ...event,
      outcome: isFinal ? "failed" : "retrying",
      nextAttemptAt: isFinal ? null : result.next_attempt_at,
    });
    if (result.disabled_now) {
      this.callHook<EndpointDisabledEvent>(
        "onEndpointDisabled",
        this.onEndpointDisabled,
        {
          endpointId: delivery.endpoint_id,
          tenantId: delivery.tenant_id,
          reason: result.disabled_reason ?? "",
        },
      );
    }
  }

  private async attempt(delivery: ClaimedDelivery): Promise<HttpResult> {
    const envelope: WebhookEnvelope = {
      type: delivery.event_type,
      timestamp: new Date(delivery.message_created_at).toISOString(),
      data: delivery.payload,
    };
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);
    const secrets = delivery.previous_secret
      ? [delivery.secret, delivery.previous_secret]
      : [delivery.secret];

    const started = performance.now();
    try {
      const signature = secrets
        .map((secret) => sign(secret, delivery.message_id, timestamp, body))
        .join(" ");
      const response = await this.transport(delivery.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": this.userAgent,
          "webhook-id": delivery.message_id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signature,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const responseBody = await readLimited(response, this.responseBodyLimit);
      const ok = response.status >= 200 && response.status < 300;
      return {
        ok,
        statusCode: response.status,
        responseBody,
        error: ok ? null : `HTTP ${response.status}`,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: null,
        responseBody: null,
        error: describeError(error, this.requestTimeoutMs),
        durationMs: Math.round(performance.now() - started),
      };
    }
  }
}

// ----------------------------------------------------------------- helpers

async function withNulHint<T>(query: Promise<T>): Promise<T> {
  try {
    return await query;
  } catch (error) {
    // 22P05 untranslatable_character: jsonb cannot store \u0000.
    if ((error as { code?: string }).code === "22P05") {
      throw new HookgresValidationError(
        `Payload contains a NUL character (\\u0000), which Postgres cannot store: remove it from the payload's strings before calling send(). See ${DOCS}/guides/sending`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Adds a hint to Postgres's `relation "hookgres.endpoints" does not exist`
 * (42P01). The error object is kept, so its class and `code` don't change.
 */
function explainMissingTables(error: unknown, schema: string): unknown {
  if (!(error instanceof Error)) return error;
  if ((error as { code?: string }).code !== "42P01") return error;
  if (error.message.includes("migrate()")) return error;
  const original = error.message;
  error.message = `${original}. Hookgres's tables are missing from schema ${schema}: call \`await hookgres.migrate()\` once before using Hookgres (on startup, or in a deploy step). See ${DOCS}/getting-started`;
  if (error.stack) error.stack = error.stack.replace(original, error.message);
  return error;
}

function assertUrl(url: string, guard: AddressGuard | null): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HookgresValidationError(
      `Invalid endpoint URL: ${url}. Pass an absolute URL like https://example.com/webhooks. See ${DOCS}/guides/endpoints`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HookgresValidationError(
      `Endpoint URL must use http or https: ${url}. See ${DOCS}/guides/endpoints`,
    );
  }
  guard?.assertEndpointUrl(parsed);
}

function normaliseEventTypes(
  eventTypes: string[] | null | undefined,
): string[] | null {
  if (eventTypes == null) return null;
  if (eventTypes.length === 0) {
    throw new HookgresValidationError(
      `eventTypes must not be empty; pass null to receive every event type. See ${DOCS}/guides/endpoints`,
    );
  }
  for (const type of eventTypes) {
    if (type === "*") {
      throw new HookgresValidationError(
        `eventTypes must not contain "*"; pass null to receive every event type. See ${DOCS}/guides/endpoints`,
      );
    }
    if (type.includes("*") && !/^[^*]+\.\*$/.test(type)) {
      throw new HookgresValidationError(
        `Invalid event type pattern "${type}": "*" is only allowed as the last segment, as in "invoice.*". See ${DOCS}/guides/endpoints`,
      );
    }
  }
  return [...new Set(eventTypes)];
}

async function readLimited(
  response: TransportResponse,
  limit: number,
): Promise<string | null> {
  if (!response.body) return null;
  if (limit === 0) {
    response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A body that fails mid-stream doesn't change the attempt's outcome.
  } finally {
    reader.cancel().catch(() => {});
  }
  return text.slice(0, limit);
}

function describeError(error: unknown, timeoutMs: number): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return `Timed out after ${timeoutMs}ms`;
  // fetch wraps the real reason ("ECONNREFUSED", "bad port", ...) in `cause`,
  // sometimes as an AggregateError when several addresses were tried.
  const cause = error.cause as ErrorDetail | undefined;
  const detail = codeOf(cause) ?? cause?.message;
  // node:http (blockPrivateAddresses) rejects with the reason itself; when
  // every address fails it's an AggregateError with an empty message.
  if (!error.message) return codeOf(error as ErrorDetail) ?? error.name;
  return detail ? `${error.message}: ${detail}` : error.message;
}

type ErrorDetail = {
  code?: string;
  message?: string;
  errors?: { code?: string }[];
};

function codeOf(error: ErrorDetail | undefined): string | undefined {
  return error?.code ?? error?.errors?.find((e) => e.code)?.code;
}

type Row = Record<string, unknown>;

function toEndpoint(row: Row | undefined): Endpoint {
  if (!row) throw new Error("Expected an endpoint row");
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    url: row.url as string,
    description: row.description as string | null,
    eventTypes: row.event_types as string[] | null,
    secret: row.secret as string,
    metadata: row.metadata as Record<string, unknown>,
    disabled: row.disabled as boolean,
    disabledReason: row.disabled_reason as string | null,
    failingSince: row.failing_since as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function toMessage(row: Row): Message {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    eventType: row.event_type as string,
    payload: row.payload,
    idempotencyKey: row.idempotency_key as string | null,
    createdAt: row.created_at as Date,
    redactedAt: (row.redacted_at as Date | null | undefined) ?? null,
  };
}

function toDelivery(row: Row): Delivery {
  return {
    id: row.id as string,
    messageId: row.message_id as string,
    endpointId: row.endpoint_id as string,
    status: row.status as DeliveryStatus,
    attemptCount: row.attempt_count as number,
    nextAttemptAt: row.next_attempt_at as Date,
    lastError: row.last_error as string | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function toAttempt(row: Row): Attempt {
  return {
    id: row.id as string,
    deliveryId: row.delivery_id as string,
    attemptNumber: row.attempt_number as number,
    statusCode: row.status_code as number | null,
    responseBody: row.response_body as string | null,
    error: row.error as string | null,
    durationMs: row.duration_ms as number,
    createdAt: row.created_at as Date,
  };
}
