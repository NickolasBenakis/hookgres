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
  type TransportRequest,
  type TransportResponse,
} from "./ssrf.js";
import type {
  AnyEvents,
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
  EventMap,
  EventSchemas,
  ListDeliveriesInput,
  Message,
  Queryable,
  SendInput,
  SendOptions,
  SendResult,
  StandardSchemaV1,
  UpdateEndpointInput,
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

/**
 * Longest duration Hookgres accepts for an option it turns into a Postgres
 * interval: far past any real schedule, well inside timestamp range.
 */
const MAX_DURATION_MS = 100 * 365 * DAY;

/** Longest delay a Node.js timer supports; longer ones fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Longest idempotency key, in bytes. Postgres's btree index entries are
 * limited to about 2700 bytes, shared with the tenant id; this leaves room.
 */
const MAX_IDEMPOTENCY_KEY_BYTES = 2000;

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
export interface HookgresOptions<E extends EventMap = AnyEvents> {
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
   * Max deliveries to one endpoint a worker sends in parallel, so a slow or
   * hanging endpoint can't take every slot and hold up other tenants.
   * Defaults to half of `concurrency`, rounded up. Set it to `concurrency`
   * to turn the limit off.
   * @see https://hookgres.dev/docs/guides/workers
   */
  maxInFlightPerEndpoint?: number;
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
  /**
   * One Standard Schema (Zod, Valibot, ArkType, ...) per event type. Types
   * `send()` from them, and at runtime `send()` validates each payload and
   * stores the schema's output; an invalid payload, or an event type with no
   * schema, throws a `HookgresValidationError` and nothing is queued.
   * `createEndpoint` and `updateEndpoint` reject `eventTypes` that match no
   * schema. For types without runtime checks, use `new Hookgres<Events>()`.
   * @see https://hookgres.dev/docs/guides/typed-events
   */
  schemas?: EventSchemas<E>;
}

interface ClaimedDelivery {
  id: string;
  lock_token: string;
  attempt_count: number;
  endpoint_id: string;
  tenant_id: string;
  message_id: string;
  event_type: string;
  /** Epoch ms, which every DateStyle gives the same way. */
  message_created_ms: number;
  /**
   * The request body, loaded after the claim and shared by every delivery of
   * the same message. Missing if the message was deleted meanwhile.
   */
  body?: string;
  /** Why the payload couldn't be loaded; recorded as a failed attempt. */
  loadError?: string;
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
export class Hookgres<E extends EventMap = AnyEvents> {
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
  private readonly maxInFlightPerEndpoint: number;
  /** When claimFair may next look past the claim window, and its backoff. */
  private wideClaimAt = 0;
  private wideClaimBackoff = 0;
  /** The pool, with a timeout on every query. Used by the worker. */
  private readonly workerDb: Queryable;
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
  private readonly schemas: Map<string, StandardSchemaV1> | null;
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
  constructor(options: HookgresOptions<E>) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else if (options.connectionString) {
      this.pool = new pg.Pool({
        connectionString: options.connectionString,
        // Probe idle connections after 10s (the OS default is 2 hours), so
        // ones a network partition killed are found. A query in progress on
        // a dead connection is bounded by the worker's query timeout.
        keepAlive: true,
        keepAliveInitialDelayMillis: 10 * SECOND,
      });
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
    if (
      !Array.isArray(this.retrySchedule) ||
      this.retrySchedule.some(
        (ms) => !Number.isFinite(ms) || ms < 0 || ms > MAX_DURATION_MS,
      )
    ) {
      throw new HookgresValidationError(
        `retrySchedule must contain non-negative numbers (delays in ms, at most ${MAX_DURATION_MS}, which is 100 years), e.g. [5000, 300000, 1800000]. See ${DOCS}/guides/retries`,
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
    this.requestTimeoutMs = durationOption(
      "requestTimeoutMs",
      options.requestTimeoutMs ?? 15 * SECOND,
      1,
      "",
      MAX_TIMER_MS,
    );
    this.disableEndpointAfterMs =
      options.disableEndpointAfterMs === undefined
        ? 5 * DAY
        : options.disableEndpointAfterMs === null
          ? null
          : durationOption(
              "disableEndpointAfterMs",
              options.disableEndpointAfterMs,
              0,
              " (or null to never disable)",
            );
    this.pollIntervalMs = durationOption(
      "pollIntervalMs",
      options.pollIntervalMs ?? SECOND,
      1,
      "",
      MAX_TIMER_MS,
    );
    const concurrency = numeric(options.concurrency ?? 10);
    if (!Number.isInteger(concurrency) || (concurrency as number) < 1) {
      throw new HookgresValidationError(
        `concurrency must be a positive integer, e.g. 10 (the default), got ${String(options.concurrency)}. See ${DOCS}/reference/configuration`,
      );
    }
    this.concurrency = concurrency as number;
    const perEndpoint = numeric(
      options.maxInFlightPerEndpoint ?? Math.ceil(this.concurrency / 2),
    );
    if (!Number.isInteger(perEndpoint) || (perEndpoint as number) < 1) {
      throw new HookgresValidationError(
        `maxInFlightPerEndpoint must be a positive integer, got ${String(options.maxInFlightPerEndpoint)}. See ${DOCS}/reference/configuration`,
      );
    }
    this.maxInFlightPerEndpoint = Math.min(
      perEndpoint as number,
      this.concurrency,
    );
    this.lockTimeoutMs = durationOption(
      "lockTimeoutMs",
      options.lockTimeoutMs ?? this.requestTimeoutMs + 30 * SECOND,
      1,
    );
    if (this.lockTimeoutMs <= this.requestTimeoutMs) {
      throw new HookgresValidationError(
        `lockTimeoutMs (${this.lockTimeoutMs}) must be greater than requestTimeoutMs (${this.requestTimeoutMs}): raise lockTimeoutMs, or omit it to use requestTimeoutMs + 30s. See ${DOCS}/reference/configuration`,
      );
    }
    // The worker's queries get the same bound as a claim's lock: past it,
    // another worker may take the delivery over anyway, and a query stuck on
    // a dead connection fails (to onError) instead of stalling the loop.
    const workerTimeoutMs = Math.min(this.lockTimeoutMs, MAX_TIMER_MS);
    this.workerDb = {
      query: <R extends QueryResultRow>(text: string, values?: unknown[]) =>
        this.timedQuery<R>(text, values, workerTimeoutMs),
    };
    this.secretRotationGraceMs = durationOption(
      "secretRotationGraceMs",
      options.secretRotationGraceMs ?? DAY,
      0,
    );
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
    this.schemas = options.schemas ? toSchemaMap(options.schemas) : null;
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
  async createEndpoint(input: CreateEndpointInput<E>): Promise<Endpoint> {
    assertUrl(input.url, this.guard);
    const eventTypes = this.checkEventTypes(input.eventTypes);
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
        eventTypes,
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
    patch: UpdateEndpointInput<E>,
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
      set("event_types", this.checkEventTypes(patch.eventTypes));
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
    // Workers lock a delivery, then its endpoint. A plain DELETE cascades in
    // the opposite order and can deadlock with them, so delete the
    // deliveries first, then the endpoint (whose cascade only finds the ones
    // queued meanwhile), and retry the rare deadlock that leaves.
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await this.query(
          `DELETE FROM ${this.t.deliveries} WHERE endpoint_id = $1`,
          [id],
          client,
        );
        const { rowCount } = await this.query(
          `DELETE FROM ${this.t.endpoints} WHERE id = $1`,
          [id],
          client,
        );
        await client.query("COMMIT");
        return (rowCount ?? 0) > 0;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if ((error as { code?: string }).code !== "40P01" || attempt >= 3) {
          throw error;
        }
      } finally {
        client.release();
      }
    }
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
    const graceMs = durationOption(
      "graceMs",
      options.graceMs ?? this.secretRotationGraceMs,
      0,
    );
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
   * `*`, a missing or non-JSON payload (a function or symbol), a payload
   * string with `\u0000` (through `fromPrisma`, that one arrives as Prisma's
   * own error) or with half a surrogate pair, or an `idempotencyKey` over
   * 2000 bytes.
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
  async send(
    input: SendInput<E>,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const event: SendInput = { ...input };
    if (this.schemas) event.payload = await this.validatePayload(event);
    return this.insertMessage(event, options);
  }

  private async insertMessage(
    input: SendInput,
    options: SendOptions,
  ): Promise<SendResult> {
    if (this.redactPayloads && !options.client) {
      // The insert and the redaction of a message with no deliveries must
      // commit together, or a failed redaction would leave the payload stored.
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.insertMessage(input, { client });
        await client.query("COMMIT");
        if (!result.deduplicated) this.wake();
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
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
    const payload = serialisePayload(input.payload);
    const idempotencyKey = input.idempotencyKey ?? null;
    if (
      idempotencyKey !== null &&
      Buffer.byteLength(String(idempotencyKey)) > MAX_IDEMPOTENCY_KEY_BYTES
    ) {
      throw new HookgresValidationError(
        `idempotencyKey is longer than ${MAX_IDEMPOTENCY_KEY_BYTES} bytes: use a short key like "invoice.paid:in_123", or a hash of a longer one. See ${DOCS}/guides/sending`,
      );
    }
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
       ), ep AS (
         -- KEY SHARE waits for a concurrent deleteEndpoint() and then skips
         -- the deleted row, instead of failing the foreign key check below
         -- (and with it the caller's transaction).
         SELECT e.id
         FROM ${this.t.endpoints} e
         WHERE e.tenant_id = $2
          AND NOT e.disabled
          -- Nothing to lock when the idempotency key deduplicated the send.
          AND EXISTS (SELECT 1 FROM m)
          AND (
            e.event_types IS NULL
            OR $3 = ANY (e.event_types)
            -- "invoice.*" matches any event type starting with "invoice."
            OR EXISTS (
              SELECT 1 FROM unnest(e.event_types) AS p (pattern)
              WHERE right(p.pattern, 2) = '.*'
                AND starts_with($3, left(p.pattern, -1))
            )
          )
         FOR KEY SHARE
       ), d AS (
         INSERT INTO ${this.t.deliveries} (message_id, endpoint_id)
         SELECT m.id, ep.id FROM m, ep
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
      let row = snakeCaseKeys(rows[0]);
      if (this.redactPayloads && row.delivery_count === 0) {
        const redacted = await this.redact(row.id as string, db);
        if (redacted) row = { ...row, ...snakeCaseKeys(redacted) };
      }
      return {
        message: toMessage(row),
        deliveryCount: row.delivery_count as number,
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
    const row = existing.rows[0] && snakeCaseKeys(existing.rows[0]);
    if (!row) {
      throw new Error(
        "The message for this idempotencyKey was deleted while send() ran (e.g. by cleanup()); retry send()",
      );
    }
    return {
      message: toMessage(row),
      deliveryCount: row.delivery_count as number,
      deduplicated: true,
    };
  }

  /** Runs the event type's schema; returns the value to store. */
  private async validatePayload(input: SendInput): Promise<unknown> {
    const schema = this.schemas?.get(input.eventType);
    if (!schema) {
      throw new HookgresValidationError(
        `No schema for event type "${input.eventType}": add it to \`schemas\` in new Hookgres(), or check the spelling. Nothing was queued. See ${DOCS}/guides/typed-events`,
      );
    }
    let result: StandardSchemaV1.Result<unknown>;
    try {
      result = await schema["~standard"].validate(input.payload);
    } catch (error) {
      // e.g. a transform that throws on bad input
      throw new HookgresValidationError(
        `The schema for "${input.eventType}" threw while validating the payload (see \`cause\`). Nothing was queued. See ${DOCS}/guides/typed-events`,
        { cause: error },
      );
    }
    if (result.issues) {
      // Paths only: some libraries quote the received value in their issue
      // messages, and this message may be returned to API callers or logged.
      const paths = [...new Set(result.issues.map(issuePath))];
      const shown = paths.slice(0, 5).join(", ");
      const more = paths.length > 5 ? ` and ${paths.length - 5} more` : "";
      throw new HookgresValidationError(
        `Invalid payload for "${input.eventType}": ${shown}${more} failed the schema (see \`issues\`). Nothing was queued. See ${DOCS}/guides/typed-events`,
        { issues: result.issues },
      );
    }
    return result.value;
  }

  /** Validates endpoint `eventTypes`, and with `schemas`, that each matches a known event type. */
  private checkEventTypes(
    eventTypes: string[] | null | undefined,
  ): string[] | null {
    const types = normaliseEventTypes(eventTypes);
    if (types && this.schemas) {
      const known = [...this.schemas.keys()];
      for (const type of types) {
        const matches = type.endsWith(".*")
          ? known.some((k) => k.startsWith(type.slice(0, -1)))
          : this.schemas.has(type);
        if (!matches) {
          throw new HookgresValidationError(
            `Unknown event type "${type}" in eventTypes: it matches no event type this app sends. See ${DOCS}/guides/typed-events`,
          );
        }
      }
    }
    return types;
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
    } else if (
      Number.isFinite(olderThan) &&
      olderThan >= 0 &&
      olderThan <= MAX_DURATION_MS
    ) {
      // Use the database clock, like every other timestamp Hookgres writes.
      // As epoch ms, not a timestamp: node-postgres can't parse timestamps
      // under a non-ISO DateStyle and would return null (deleting nothing).
      const { rows } = await this.query<{ cutoff_ms: number }>(
        "SELECT (extract(epoch FROM now() - make_interval(secs => $1::double precision / 1000)) * 1000)::float8 AS cutoff_ms",
        [olderThan],
      );
      cutoff = new Date((rows[0] as { cutoff_ms: number }).cutoff_ms);
    } else {
      throw new HookgresValidationError(
        `cleanup olderThan must be a Date or a non-negative number of ms (at most ${MAX_DURATION_MS}, which is 100 years), e.g. { olderThan: 30 * 24 * 60 * 60 * 1000 } for 30 days. See ${DOCS}/guides/production#clean-up-old-rows`,
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
    if (tenantId !== undefined && typeof tenantId !== "string") {
      throw new HookgresValidationError(
        `deleteMessages tenantId must be a string. See ${DOCS}/guides/privacy`,
      );
    }
    if (
      messageIds !== undefined &&
      (!Array.isArray(messageIds) ||
        messageIds.some((id) => typeof id !== "string"))
    ) {
      throw new HookgresValidationError(
        `deleteMessages messageIds must be an array of message id strings. See ${DOCS}/guides/privacy`,
      );
    }
    // `payload @> '{}'` matches every payload. Anything JSON.stringify drops
    // or changes (undefined, a function, NaN, an object with toJSON) could
    // turn a narrow filter into that, so only plain JSON is accepted.
    if (payloadContains !== undefined && !isStrictJsonFilter(payloadContains)) {
      throw new HookgresValidationError(
        `deleteMessages payloadContains must be a non-empty plain object or array of strings, finite numbers, booleans and null (no undefined, functions, NaN, Dates or empty objects/arrays), e.g. { userId: "usr_123" }. See ${DOCS}/guides/privacy`,
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

    const filterSql = where.join(" AND ");
    let deleted = 0;
    for (;;) {
      const { rowCount } = await this.query(
        `DELETE FROM ${this.t.messages}
         WHERE id IN (
           SELECT id FROM ${this.t.messages}
           WHERE ${filterSql}
           LIMIT $${values.length}
         )`,
        values,
      );
      deleted += rowCount ?? 0;
      if (rowCount) continue;
      // An empty batch can also mean another transaction (cleanup(), or a
      // second deleteMessages) deleted the rows this batch picked; only stop
      // once nothing matches.
      const { rows } = await this.query<{ left: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${this.t.messages} WHERE ${filterSql}) AS left`,
        values.slice(0, -1),
      );
      if (!rows[0]?.left) return deleted;
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
    const limit = numeric(input.limit ?? 50);
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      throw new HookgresValidationError(
        `listDeliveries limit must be a number (1 to 500), got ${String(input.limit)}. See ${DOCS}/reference/api`,
      );
    }
    values.push(Math.min(Math.max(1, Math.trunc(limit)), 500));
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
    const claimed = await this.claimFair(this.concurrency, new Map());
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

  /**
   * Keeps up to `concurrency` deliveries in flight, claiming more as each one
   * finishes rather than waiting for a whole batch, so one slow receiver
   * doesn't leave the other slots idle.
   */
  private async loop(active: () => boolean): Promise<void> {
    const inFlight = new Map<string, number>();
    const running = new Set<Promise<void>>();
    while (active()) {
      const free = this.concurrency - running.size;
      let claimed: ClaimedDelivery[] = [];
      if (free > 0) {
        try {
          claimed = await this.claimFair(free, inFlight);
        } catch (error) {
          this.reportError(error);
        }
      }
      for (const delivery of claimed) {
        const endpointId = delivery.endpoint_id;
        inFlight.set(endpointId, (inFlight.get(endpointId) ?? 0) + 1);
        const done: Promise<void> = this.process(delivery)
          .catch((error) => this.reportError(error))
          .finally(() => {
            running.delete(done);
            const left = (inFlight.get(endpointId) ?? 1) - 1;
            if (left > 0) inFlight.set(endpointId, left);
            else inFlight.delete(endpointId);
            this.wake(); // a slot is free
          });
        running.add(done);
      }
      if (!active()) break;
      if (free > 0 && claimed.length === free) continue; // more may be due
      // Until a slot frees up, a send wakes it, or the poll interval passes.
      await this.sleep(this.pollIntervalMs);
    }
    await Promise.all(running);
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

  /**
   * Runs a worker query that gives up after `timeoutMs`: waiting for a pool
   * connection, and running. On a timeout it also cancels the statement on
   * the server, so a query that was only waiting (on a lock, say) doesn't
   * commit later behind the worker's back, and discards the connection.
   */
  private async timedQuery<R extends QueryResultRow>(
    text: string,
    values: unknown[] | undefined,
    timeoutMs: number,
  ): Promise<QueryResult<R>> {
    const client = await this.connectWithin(timeoutMs);
    try {
      // node-postgres supports a per-query query_timeout; @types/pg only
      // declares it on the client config.
      const result = await client.query<R>({
        text,
        values,
        query_timeout: timeoutMs,
      } as pg.QueryConfig);
      client.release();
      return result;
    } catch (error) {
      const pid = (client as { processID?: number }).processID;
      if ((error as Error).message === "Query read timeout" && pid) {
        // Wait for the cancel, so the caller never sees the timeout while the
        // statement could still commit. Bounded: the database may be gone.
        // Keeping this connection checked out until then keeps the pid ours.
        await this.cancelBackend(pid, Math.min(timeoutMs, 5 * SECOND)).catch(
          () => {},
        );
      }
      client.release(error as Error);
      throw explainMissingTables(error, this.schema);
    }
  }

  /** Checks out a pool connection, giving up after `timeoutMs`. */
  private async connectWithin(timeoutMs: number): Promise<pg.PoolClient> {
    const connecting = this.pool.connect();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        connecting,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out after ${timeoutMs}ms waiting for a database connection`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      // Hand back the connection if it arrives after all.
      connecting.then(
        (late) => late.release(),
        () => {},
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Cancels a statement over a connection of its own, outside the pool: the
   * pool may be full of connections waiting on the same lock, or on their
   * own cancels.
   */
  private async cancelBackend(pid: number, timeoutMs: number): Promise<void> {
    const Client =
      (this.pool as unknown as { Client?: typeof pg.Client }).Client ??
      pg.Client;
    const client = new Client({
      ...this.pool.options,
      connectionTimeoutMillis: timeoutMs,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      await client.query({
        text: "SELECT pg_cancel_backend($1)",
        values: [pid],
        query_timeout: timeoutMs,
      } as pg.QueryConfig);
    } finally {
      client.end().catch(() => {});
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

  /**
   * Claims up to `free` due deliveries, oldest first, with at most
   * `maxInFlightPerEndpoint` per endpoint counting the ones already
   * `inFlight`, so one endpoint's backlog can't fill every slot.
   */
  private async claimFair(
    free: number,
    inFlight: ReadonlyMap<string, number>,
  ): Promise<ClaimedDelivery[]> {
    const cap = this.maxInFlightPerEndpoint;
    const allowance = new Map<string, number>();
    for (const [id, n] of inFlight) allowance.set(id, Math.max(0, cap - n));
    let claimed = await this.claim(free, allowance);
    if (claimed.length === 0 && (await this.hasDueWork())) {
      // Due rows exist but were locked by a concurrent claim's scan, which
      // lasts milliseconds: try once more instead of reporting nothing.
      await new Promise((resolve) =>
        setTimeout(resolve, 5 + Math.random() * 20),
      );
      claimed = await this.claim(free, allowance);
    }
    // These rows are committed as claimed with an attempt counted. Until
    // they're returned or put back, an error would strand them until their
    // lock expires, with an attempt spent and nothing sent.
    const held = new Set(claimed);
    const putBack = async (rows: ClaimedDelivery[]) => {
      await this.unclaim(rows);
      for (const row of rows) held.delete(row);
    };
    try {
      // A lock-expired row bypasses the window's per-endpoint ranking; put
      // anything over an endpoint's share back.
      const kept: ClaimedDelivery[] = [];
      const take = (rows: ClaimedDelivery[]) => {
        const extra: ClaimedDelivery[] = [];
        for (const row of rows) {
          const left = allowance.get(row.endpoint_id) ?? cap;
          if (left > 0) {
            allowance.set(row.endpoint_id, left - 1);
            kept.push(row);
          } else {
            extra.push(row);
          }
        }
        return extra;
      };
      // If putting rows back fails they stay held: still worth delivering
      // the rest, and the lock expiry recovers them.
      const extra = take(claimed);
      if (extra.length > 0)
        await putBack(extra).catch((e) => this.reportError(e));

      // The window only holds the oldest due rows. If full endpoints' backlogs
      // fill it, look past it so other tenants still get served. That scan
      // reads those backlogs, so after one that finds nothing, back off.
      const full = [...allowance].filter(([, n]) => n === 0).map(([id]) => id);
      if (
        kept.length < free &&
        full.length > 0 &&
        // Monotonic: a wall-clock step back mustn't stall this for hours.
        performance.now() >= this.wideClaimAt
      ) {
        let more: ClaimedDelivery[] | undefined;
        try {
          more = await this.claimPast(free - kept.length, full);
        } catch (error) {
          // Keep what's already claimed; report the rest.
          this.reportError(error);
          this.backOffWideClaim();
        }
        if (more) {
          for (const row of more) held.add(row);
          const over = take(more);
          if (over.length > 0)
            await putBack(over).catch((e) => this.reportError(e));
          if (more.length) {
            this.wideClaimBackoff = 0;
            this.wideClaimAt = 0;
          } else {
            this.backOffWideClaim();
          }
        }
      }
      await this.loadBodies(kept);
      return kept;
    } catch (error) {
      if (held.size > 0) {
        await this.unclaim([...held]).catch((unclaimError) =>
          this.reportError(unclaimError),
        );
      }
      throw error;
    }
  }

  /** Waits longer before the next scan past the window, up to 10 polls. */
  private backOffWideClaim(): void {
    this.wideClaimBackoff = Math.min(
      Math.max(this.pollIntervalMs, this.wideClaimBackoff * 2),
      10 * this.pollIntervalMs,
    );
    this.wideClaimAt = performance.now() + this.wideClaimBackoff;
  }

  /**
   * Loads the payload of each claimed message once, as JSON text, and builds
   * its request body once for all its deliveries. The claim itself returns
   * no payloads: a big message fanned out to many endpoints would otherwise
   * be loaded (and parsed) once per delivery, and a worker running out of
   * memory there would abort the claim and retry it forever.
   */
  private async loadBodies(claimed: ClaimedDelivery[]): Promise<void> {
    // Not for deliveries process() fails without sending: loading a payload
    // too big for the worker must not happen again on every reclaim.
    const sendable = claimed.filter(
      (d) =>
        !d.redacted &&
        !d.disabled &&
        d.attempt_count <= this.retrySchedule.length + 1,
    );
    const ids = [...new Set(sendable.map((d) => d.message_id))];
    if (ids.length === 0) return;
    let payloads: Map<string, string | null>;
    try {
      payloads = await this.loadPayloads(ids);
    } catch {
      // The claim has committed: don't drop the batch. Load message by
      // message, and record a failed attempt for any that still fails.
      payloads = new Map();
      for (const id of ids) {
        try {
          for (const [k, v] of await this.loadPayloads([id]))
            payloads.set(k, v);
        } catch (error) {
          for (const d of sendable) {
            if (d.message_id === id) {
              d.loadError = `Couldn't load the payload: ${(error as Error).message}`;
            }
          }
        }
      }
    }
    const bodies = new Map<string, string>();
    for (const delivery of sendable) {
      if (delivery.loadError) continue;
      if (!payloads.has(delivery.message_id)) continue; // deleted meanwhile
      const payload = payloads.get(delivery.message_id);
      if (payload == null) {
        delivery.redacted = true; // redacted after the claim
        continue;
      }
      let body = bodies.get(delivery.message_id);
      if (body === undefined) {
        const timestamp = new Date(delivery.message_created_ms).toISOString();
        body = `{"type":${JSON.stringify(delivery.event_type)},"timestamp":"${timestamp}","data":${payload}}`;
        bodies.set(delivery.message_id, body);
      }
      delivery.body = body;
    }
  }

  private async loadPayloads(
    ids: string[],
  ): Promise<Map<string, string | null>> {
    const { rows } = await this.query<{ id: string; payload: string | null }>(
      `SELECT id, payload::text AS payload FROM ${this.t.messages}
       WHERE id = ANY ($1::text[])`,
      [ids],
      this.workerDb,
    );
    return new Map(rows.map((r) => [r.id, r.payload]));
  }

  /** Whether any pending delivery is due (one index probe). */
  private async hasDueWork(): Promise<boolean> {
    const { rows } = await this.query<{ due: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${this.t.deliveries}
         WHERE status = 'pending' AND next_attempt_at <= now()
       ) AS due`,
      [],
      this.workerDb,
    );
    return rows[0]?.due === true;
  }

  /** Puts claimed deliveries back, as if they had never been claimed. */
  private async unclaim(deliveries: ClaimedDelivery[]): Promise<void> {
    await this.query(
      `UPDATE ${this.t.deliveries} d
       SET status = 'pending', locked_until = NULL, lock_token = NULL,
           attempt_count = d.attempt_count - 1, updated_at = now()
       FROM unnest($1::text[], $2::uuid[]) AS c (id, lock_token)
       WHERE d.id = c.id AND d.lock_token = c.lock_token`,
      [deliveries.map((d) => d.id), deliveries.map((d) => d.lock_token)],
      this.workerDb,
    );
  }

  private static readonly CLAIM_RETURNING =
    `RETURNING d.id, d.lock_token, d.attempt_count, d.endpoint_id,
                 m.tenant_id, m.id AS message_id,
                 m.event_type,
                 (extract(epoch FROM m.created_at) * 1000)::float8 AS message_created_ms,
                 m.redacted_at IS NOT NULL AS redacted,
                 e.url, e.secret,
                 CASE WHEN e.previous_secret_expires_at > now()
                      THEN e.previous_secret END AS previous_secret,
                 e.disabled`;

  /**
   * Claims up to `limit` due deliveries from a window of the oldest due rows
   * it could lock, ranking each endpoint's rows so none goes over its
   * `allowance` (the per-endpoint cap when not listed). Index-ordered and
   * limited, so its cost doesn't grow with the backlog.
   */
  private async claim(
    limit: number,
    allowance: ReadonlyMap<string, number>,
  ): Promise<ClaimedDelivery[]> {
    const { rows } = await this.query<ClaimedDelivery>(
      `WITH window_rows AS (
         -- Lock while scanning, so rows other workers are claiming are
         -- skipped here instead of counting against an endpoint's share.
         -- Rows locked but not picked below are released when this ends.
         SELECT id, endpoint_id, next_attempt_at AS due_at
         FROM ${this.t.deliveries}
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at
         LIMIT $5
         FOR UPDATE SKIP LOCKED
       ), ranked AS (
         SELECT w.id, w.due_at,
                row_number() OVER (PARTITION BY w.endpoint_id ORDER BY w.due_at) AS n,
                COALESCE(a.allowance, $4) AS allowance
         FROM window_rows w
         LEFT JOIN unnest($3::text[], $6::int[]) AS a (endpoint_id, allowance)
           ON a.endpoint_id = w.endpoint_id
       ), pending AS (
         SELECT id, due_at FROM ranked
         WHERE n <= allowance
         ORDER BY due_at
         LIMIT $1
       ), expired AS (
         -- Claimed by a worker that crashed: its lock has run out.
         SELECT id, locked_until AS due_at FROM ${this.t.deliveries}
         WHERE status = 'delivering' AND locked_until < now()
         ORDER BY locked_until
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ), due AS (
         SELECT id FROM (
           SELECT * FROM pending UNION ALL SELECT * FROM expired
         ) candidates
         ORDER BY due_at
         LIMIT $1
       )
       UPDATE ${this.t.deliveries} d
       SET status = 'delivering',
           locked_until = now() + make_interval(secs => $2::double precision / 1000),
           lock_token = gen_random_uuid(),
           attempt_count = d.attempt_count + 1,
           updated_at = now()
       FROM due, ${this.t.messages} m, ${this.t.endpoints} e
       WHERE d.id = due.id AND m.id = d.message_id AND e.id = d.endpoint_id
       ${Hookgres.CLAIM_RETURNING}`,
      [
        limit,
        this.lockTimeoutMs,
        [...allowance.keys()],
        this.maxInFlightPerEndpoint,
        // Room to skip past one busy endpoint without reading its backlog;
        // claimPast handles a window it fills.
        limit * 4,
        [...allowance.values()],
      ],
      this.workerDb,
    );
    return rows;
  }

  /**
   * Claims due deliveries of endpoints other than `skip`, past the window:
   * reads the skipped endpoints' rows, so only for when they fill it.
   */
  private async claimPast(
    limit: number,
    skip: string[],
  ): Promise<ClaimedDelivery[]> {
    const { rows } = await this.query<ClaimedDelivery>(
      `WITH due AS (
         SELECT id FROM ${this.t.deliveries}
         WHERE status = 'pending' AND next_attempt_at <= now()
           AND endpoint_id <> ALL ($3::text[])
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
       ${Hookgres.CLAIM_RETURNING}`,
      [limit, this.lockTimeoutMs, skip],
      this.workerDb,
    );
    return rows;
  }

  /**
   * Fails the pending deliveries of an endpoint that was just disabled
   * automatically. Runs after the disabling statement committed, so its
   * snapshot also sees deliveries other workers put back to `pending` while
   * that statement waited for the endpoint lock, and in batches, so it never
   * holds the endpoint lock that `send()` waits on. Ones in flight fail when
   * their worker records them. If this never runs (a crash), `claim()` still
   * fails them when they come due.
   */
  private async failQueuedDeliveries(endpointId: string): Promise<void> {
    for (;;) {
      const { rowCount } = await this.query(
        `UPDATE ${this.t.deliveries}
         SET status = 'failed', last_error = 'Endpoint is disabled', updated_at = now()
         WHERE id IN (
           SELECT id FROM ${this.t.deliveries}
           WHERE endpoint_id = $1 AND status = 'pending'
           LIMIT 1000
           FOR UPDATE SKIP LOCKED
         )`,
        [endpointId],
        this.workerDb,
      );
      if (!rowCount) return;
    }
  }

  /**
   * Marks a claimed delivery failed without sending it. Gives back the
   * attempt the claim counted, since no HTTP request was made.
   */
  private async failWithoutSending(
    delivery: ClaimedDelivery,
    reason: string,
  ): Promise<void> {
    await this.query(
      `UPDATE ${this.t.deliveries}
       SET status = 'failed', locked_until = NULL, lock_token = NULL,
           attempt_count = attempt_count - 1,
           last_error = $3, updated_at = now()
       WHERE id = $1 AND lock_token = $2`,
      [delivery.id, delivery.lock_token, reason],
      this.workerDb,
    );
  }

  private async process(delivery: ClaimedDelivery): Promise<void> {
    if (delivery.disabled) {
      await this.failWithoutSending(delivery, "Endpoint is disabled");
      return;
    }
    // Deleted (deleteMessages, cleanup) after the claim: the delivery went
    // with it, so there's nothing to send or record.
    if (
      delivery.body === undefined &&
      !delivery.redacted &&
      !delivery.loadError &&
      !delivery.disabled &&
      delivery.attempt_count <= this.retrySchedule.length + 1
    ) {
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
        this.workerDb,
      );
      if (rowCount) {
        this.callHook<AttemptEvent>("onAttempt", this.onAttempt, {
          ...event,
          outcome: "succeeded",
          nextAttemptAt: null,
        });
        // A separate statement, after the success above committed: of two
        // last deliveries succeeding at once, the later one sees both.
        if (this.redactPayloads)
          await this.redact(delivery.message_id, this.workerDb);
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
      failed: boolean;
      disabled_now: boolean | null;
      disabled_reason: string | null;
    }>(
      `WITH cur AS (
         -- Locks the delivery first, then its endpoint (the same order as
         -- before), and finds nothing if another worker took over the claim.
         SELECT id, endpoint_id FROM ${this.t.deliveries}
         WHERE id = $1 AND lock_token = $2
         FOR UPDATE
       ), e AS (
         -- One UPDATE, no separate lock first: locking the row and then
         -- updating it in one statement deadlocked between workers once open
         -- send() transactions held KEY SHARE locks on it. disabled_xid is set
         -- to this transaction's id only by the update that disables the
         -- endpoint, which is how only that worker reports it. (A timestamp
         -- can't do this: two workers can start in the same microsecond.)
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
             disabled_at = CASE
               WHEN NOT disabled AND $10::double precision IS NOT NULL AND
                    COALESCE(failing_since, now()) <= now() - make_interval(secs => $10::double precision / 1000)
               THEN now()
               ELSE disabled_at
             END,
             disabled_xid = CASE
               WHEN NOT disabled AND $10::double precision IS NOT NULL AND
                    COALESCE(failing_since, now()) <= now() - make_interval(secs => $10::double precision / 1000)
               THEN pg_current_xact_id()
               ELSE disabled_xid
             END,
             updated_at = now()
         WHERE id IN (SELECT endpoint_id FROM cur)
         RETURNING id, disabled AND disabled_xid = pg_current_xact_id() AS disabled_now,
                   -- Disabled automatically, now or earlier: no more retries.
                   -- A manual disable is a pause, so retries continue.
                   disabled AND disabled_reason IS DISTINCT FROM 'Disabled manually'
                     AS auto_disabled,
                   disabled_reason
       ), d AS (
         UPDATE ${this.t.deliveries}
         SET status = CASE WHEN $8::boolean OR (SELECT auto_disabled FROM e) THEN 'failed' ELSE 'pending' END,
             next_attempt_at = CASE WHEN $8::boolean OR (SELECT auto_disabled FROM e) THEN now()
                                    ELSE now() + make_interval(secs => $9::double precision / 1000) END,
             locked_until = NULL,
             lock_token = NULL,
             last_error = $6,
             updated_at = now()
         FROM cur
         WHERE ${this.t.deliveries}.id = cur.id
         RETURNING ${this.t.deliveries}.id, next_attempt_at, status = 'failed' AS failed
       ), a AS (
         INSERT INTO ${this.t.attempts}
           (delivery_id, attempt_number, status_code, response_body, error, duration_ms)
         SELECT d.id, $3, $4, $5, $6, $7 FROM d
       )
       SELECT d.next_attempt_at, d.failed, e.disabled_now, e.disabled_reason
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
      this.workerDb,
    );
    const result = rows[0];
    if (!result) return;
    this.callHook<AttemptEvent>("onAttempt", this.onAttempt, {
      ...event,
      outcome: result.failed ? "failed" : "retrying",
      nextAttemptAt: result.failed ? null : toDate(result.next_attempt_at),
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
      await this.failQueuedDeliveries(delivery.endpoint_id);
    }
  }

  private async attempt(delivery: ClaimedDelivery): Promise<HttpResult> {
    if (delivery.loadError) {
      return {
        ok: false,
        statusCode: null,
        responseBody: null,
        error: delivery.loadError,
        durationMs: 0,
      };
    }
    const body = delivery.body as string;
    const timestamp = Math.floor(Date.now() / 1000);
    const secrets = delivery.previous_secret
      ? [delivery.secret, delivery.previous_secret]
      : [delivery.secret];

    const started = performance.now();
    try {
      const signature = secrets
        .map((secret) => sign(secret, delivery.message_id, timestamp, body))
        .join(" ");
      const init: TransportRequest = {
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
      };
      let response: TransportResponse;
      try {
        response = await this.transport(delivery.url, init);
      } catch (error) {
        // fetch reports a keep-alive connection the receiver closed just as
        // it was reused as UND_ERR_SOCKET ("other side closed"). Retry once
        // on a fresh connection, within the same timeout.
        const code = (error as { cause?: { code?: string } }).cause?.code;
        if (code !== "UND_ERR_SOCKET" || init.signal.aborted) throw error;
        response = await this.transport(delivery.url, init);
      }
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
 * True for a non-empty plain object or array whose leaves are strings,
 * finite numbers, booleans or null, with no empty object or array inside:
 * exactly what JSON.stringify keeps as is.
 */
function isStrictJsonFilter(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isStrictJsonValue);
  }
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if ("toJSON" in value) return false;
  const children = Object.values(value);
  return children.length > 0 && children.every(isStrictJsonValue);
}

function isStrictJsonValue(value: unknown): boolean {
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      return value === null || isStrictJsonFilter(value);
    default:
      return false;
  }
}

/**
 * Adds a hint to Postgres's `relation "hookgres.endpoints" does not exist`
 * (42P01), or `column ... does not exist` (42703) after an upgrade that
 * hasn't run `migrate()`. The error object is kept, so its class and `code`
 * don't change.
 */
function explainMissingTables(error: unknown, schema: string): unknown {
  if (!(error instanceof Error)) return error;
  const code = (error as { code?: string }).code;
  if (code !== "42P01" && code !== "42703") return error;
  if (error.message.includes("migrate()")) return error;
  const original = error.message;
  error.message =
    code === "42P01"
      ? `${original}. Hookgres's tables are missing from schema ${schema}: call \`await hookgres.migrate()\` once before using Hookgres (on startup, or in a deploy step). See ${DOCS}/getting-started`
      : `${original}. Hookgres's tables in schema ${schema} may be from an older version: call \`await hookgres.migrate()\` after upgrading, before the new code serves traffic. See ${DOCS}/getting-started`;
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
  // fetch refuses to send these, so the endpoint could never receive anything,
  // and the password would end up in error messages.
  if (parsed.username || parsed.password) {
    throw new HookgresValidationError(
      `Endpoint URL must not contain credentials (user:password@): ${redactCredentials(url)}. Have the receiver authenticate with the webhook signature instead. See ${DOCS}/guides/endpoints`,
    );
  }
  guard?.assertEndpointUrl(parsed);
}

function toSchemaMap(
  schemas: Record<string, StandardSchemaV1>,
): Map<string, StandardSchemaV1> {
  const map = new Map<string, StandardSchemaV1>();
  for (const [type, schema] of Object.entries(schemas)) {
    if (type.includes("*")) {
      throw new HookgresValidationError(
        `Invalid event type "${type}" in schemas: use concrete event types like "invoice.paid", without "*". See ${DOCS}/guides/typed-events`,
      );
    }
    if (typeof schema?.["~standard"]?.validate !== "function") {
      throw new HookgresValidationError(
        `schemas["${type}"] is not a Standard Schema: pass a schema from a library that implements https://standardschema.dev, such as Zod 3.24+, Valibot 1 or ArkType. See ${DOCS}/guides/typed-events`,
      );
    }
    map.set(type, schema);
  }
  return map;
}

function issuePath(issue: StandardSchemaV1.Issue): string {
  const keys = (issue.path ?? []).map((segment) =>
    typeof segment === "object" ? segment.key : segment,
  );
  return ["payload", ...keys.map(String)].join(".");
}

function normaliseEventTypes(
  eventTypes: string[] | null | undefined,
): string[] | null {
  if (eventTypes == null) return null;
  // A string (say, straight from a form) would otherwise be split into
  // one-character patterns that never match.
  if (
    !Array.isArray(eventTypes) ||
    eventTypes.some((type) => typeof type !== "string")
  ) {
    throw new HookgresValidationError(
      `eventTypes must be an array of strings, like ["invoice.paid"], or null for every event type; got ${JSON.stringify(eventTypes)}. See ${DOCS}/guides/endpoints`,
    );
  }
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
  // Endpoints stored before credentials were refused: keep the password out
  // of last_error, the attempt log and onAttempt.
  return redactCredentials(
    detail ? `${error.message}: ${detail}` : error.message,
  );
}

/** Replaces the user:password@ part of any URL in `text` with `***@`. */
function redactCredentials(text: string): string {
  return text.replace(/(\w+:\/\/)[^\s/@]+@/g, "$1***@");
}

/**
 * Timestamps from the pool are Dates, unless the app's pool parses timestamptz
 * as strings (a custom type parser). Accept both, so the types hold.
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : parseTimestamptz(String(value));
}

/** node-postgres's own timestamptz parser, which handles Postgres's format. */
const parseTimestamptz = pg.types.getTypeParser(1184) as (text: string) => Date;

function toDateOrNull(value: unknown): Date | null {
  return value == null ? null : toDate(value);
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
    failingSince: toDateOrNull(row.failing_since),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/**
 * Rows read through a caller's client can come back with camelCase keys (a
 * query builder's snake-to-camel mapper, like Knex's postProcessResponse).
 * Hookgres's columns are all snake_case, so map them back.
 */
function snakeCaseKeys(row: Row): Row {
  if (!Object.keys(row).some((key) => /[A-Z]/.test(key))) return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      value,
    ]),
  );
}

function toMessage(row: Row): Message {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    eventType: row.event_type as string,
    payload: row.payload,
    idempotencyKey: row.idempotency_key as string | null,
    // send() may run on a caller's client whose driver returns timestamps as
    // strings (Drizzle does), so parse them instead of trusting the type.
    createdAt: toDate(row.created_at),
    redactedAt: toDateOrNull(row.redacted_at),
  };
}

function toDelivery(row: Row): Delivery {
  return {
    id: row.id as string,
    messageId: row.message_id as string,
    endpointId: row.endpoint_id as string,
    status: row.status as DeliveryStatus,
    attemptCount: row.attempt_count as number,
    nextAttemptAt: toDate(row.next_attempt_at),
    lastError: row.last_error as string | null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
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
    createdAt: toDate(row.created_at),
  };
}

/**
 * Checks a duration option in ms: a finite number from `min` to `max`. NaN
 * (often `Number(process.env.X)` of an unset variable) would slip past every
 * comparison and break the worker later, so it's rejected here.
 */
function durationOption(
  name: string,
  input: number,
  min: number,
  hint = "",
  max = MAX_DURATION_MS,
): number {
  const value = numeric(input);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new HookgresValidationError(
      `${name} must be a number of milliseconds from ${min} to ${max}${hint}, got ${String(value)}. See ${DOCS}/reference/configuration`,
    );
  }
  return value;
}

/**
 * JSON.stringify, refusing payloads Postgres's jsonb can't store or that
 * would silently turn into null: a function or symbol (JSON.stringify
 * returns undefined), and strings with an unpaired UTF-16 surrogate (half an
 * emoji, say), which jsonb rejects with a cryptic error.
 */
// In unicode mode a surrogate pair is one code point; only a lone half is \p{Cs}.
const LONE_SURROGATE = /\p{Cs}/u;

function serialisePayload(payload: unknown): string {
  let malformed: string | undefined;
  let unsupported: string | undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(payload, (key, value) => {
      // JSON.stringify turns these into {} and the data is lost.
      if (unsupported === undefined) {
        if (value instanceof Map) unsupported = "a Map";
        else if (value instanceof Set) unsupported = "a Set";
      }
      if (malformed === undefined) {
        if (LONE_SURROGATE.test(key)) malformed = key;
        else if (typeof value === "string" && LONE_SURROGATE.test(value)) {
          malformed = value;
        }
      }
      return value;
    });
  } catch (error) {
    // A BigInt, or a circular reference.
    throw new HookgresValidationError(
      `send() payload must be JSON-serialisable: ${(error as Error).message}. Convert BigInt values to strings or numbers first. See ${DOCS}/guides/sending`,
      { cause: error },
    );
  }
  if (unsupported !== undefined) {
    throw new HookgresValidationError(
      `send() payload contains ${unsupported}, which JSON turns into {}: convert it to an array or a plain object first. See ${DOCS}/guides/sending`,
    );
  }
  if (json === undefined) {
    throw new HookgresValidationError(
      `send() payload must be JSON-serialisable, got ${typeof payload === "function" ? "a function" : typeof payload}: pass plain data (use null or {} for none). See ${DOCS}/guides/sending`,
    );
  }
  if (malformed !== undefined) {
    throw new HookgresValidationError(
      `send() payload contains a string with an unpaired UTF-16 surrogate, which Postgres can't store (often text cut in the middle of an emoji): ${JSON.stringify(malformed.slice(0, 40))}. See ${DOCS}/guides/sending`,
    );
  }
  return json;
}

/**
 * Numbers passed as strings (often straight from process.env) used to work
 * through implicit coercion, so keep accepting numeric strings.
 */
function numeric(value: unknown): unknown {
  return typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
}
