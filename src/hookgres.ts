import pg from "pg";
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
  CleanupOptions,
  CreateEndpointInput,
  Delivery,
  DeliveryStatus,
  Endpoint,
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

/** Delay before each retry: 8 attempts over roughly 28 hours. */
export const DEFAULT_RETRY_SCHEDULE = [
  5 * SECOND,
  5 * MINUTE,
  30 * MINUTE,
  2 * HOUR,
  5 * HOUR,
  10 * HOUR,
  10 * HOUR,
];

const RESPONSE_BODY_LIMIT = 4096;

export interface HookgresOptions {
  /** An existing `pg.Pool`. Hookgres never closes a pool it did not create. */
  pool?: pg.Pool;
  /** Alternatively, a connection string; Hookgres creates and owns the pool. */
  connectionString?: string;
  /** Postgres schema for Hookgres's tables. Defaults to `hookgres`. */
  schema?: string;
  /** Delay in ms before each retry. Its length + 1 is the max attempt count. */
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
  userAgent?: string;
  /** Called for unexpected worker errors. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
}

interface ClaimedDelivery {
  id: string;
  lock_token: string;
  attempt_count: number;
  message_id: string;
  event_type: string;
  payload: unknown;
  message_created_at: Date;
  url: string;
  secret: string;
  /** Only set while the rotation grace period is running. */
  previous_secret: string | null;
  disabled: boolean;
}

interface AttemptOutcome {
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
  private readonly guard: AddressGuard | null;
  private readonly transport: Transport;
  private readonly closeTransport: () => void;
  private readonly userAgent: string;
  private readonly onError: (error: unknown) => void;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private wakePending = false;
  private generation = 0;

  constructor(options: HookgresOptions) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else if (options.connectionString) {
      this.pool = new pg.Pool({ connectionString: options.connectionString });
      this.ownsPool = true;
    } else {
      throw new Error("Hookgres needs either `pool` or `connectionString`");
    }

    const schema = options.schema ?? "hookgres";
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
      throw new Error(
        `Invalid schema name "${schema}": use lowercase letters, digits and underscores`,
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
      throw new Error("retrySchedule must contain non-negative numbers");
    }
    this.retryJitter = options.retryJitter ?? 0.1;
    if (
      !Number.isFinite(this.retryJitter) ||
      this.retryJitter < 0 ||
      this.retryJitter > 1
    ) {
      throw new Error("retryJitter must be a number between 0 and 1");
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
      throw new Error("lockTimeoutMs must be greater than requestTimeoutMs");
    }
    this.secretRotationGraceMs = options.secretRotationGraceMs ?? DAY;
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
  }

  // ---------------------------------------------------------------- schema

  /** Creates or upgrades Hookgres's tables. Safe to run concurrently. */
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
   * @see https://hookgres.dev/docs/guides/endpoints
   */
  async createEndpoint(input: CreateEndpointInput): Promise<Endpoint> {
    assertUrl(input.url, this.guard);
    const { rows } = await this.pool.query(
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

  /** Returns the endpoint, or `null`. Includes its secret: check the tenant before returning it. */
  async getEndpoint(id: string): Promise<Endpoint | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t.endpoints} WHERE id = $1`,
      [id],
    );
    return rows[0] ? toEndpoint(rows[0]) : null;
  }

  /** Returns all of a tenant's endpoints, oldest first. */
  async listEndpoints(tenantId: string): Promise<Endpoint[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t.endpoints} WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return rows.map(toEndpoint);
  }

  /**
   * Changes only the fields given. `disabled: false` re-enables an endpoint
   * and clears its failure state. Returns `null` if it doesn't exist.
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
    const { rows } = await this.pool.query(
      `UPDATE ${this.t.endpoints}
       SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${values.length}
       RETURNING *`,
      values,
    );
    return rows[0] ? toEndpoint(rows[0]) : null;
  }

  /** Deletes an endpoint together with its deliveries and attempts. */
  async deleteEndpoint(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM ${this.t.endpoints} WHERE id = $1`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Replaces the signing secret. Deliveries are signed with both the new and
   * the old secret until the grace period ends, so receivers can roll over.
   * Only one previous secret is kept: rotating again ends the earlier grace
   * period immediately.
   */
  async rotateEndpointSecret(
    id: string,
    options: { secret?: string; graceMs?: number } = {},
  ): Promise<Endpoint | null> {
    const graceMs = options.graceMs ?? this.secretRotationGraceMs;
    const { rows } = await this.pool.query(
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
   * statement; pass `options.client` to make it part of your transaction.
   */
  async send(input: SendInput, options: SendOptions = {}): Promise<SendResult> {
    const db: Queryable = options.client ?? this.pool;
    if (input.eventType.includes("*")) {
      throw new Error(
        `Invalid event type "${input.eventType}": "*" is only allowed in an endpoint's eventTypes`,
      );
    }
    if (input.payload === undefined) {
      throw new Error("send() requires a JSON-serialisable payload");
    }
    const payload = JSON.stringify(input.payload);
    const idempotencyKey = input.idempotencyKey ?? null;

    const { rows } = await queryWithNulHint(
      db,
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
       )
       SELECT m.*, (SELECT count(*) FROM d)::int AS delivery_count FROM m`,
      [newId("msg"), input.tenantId, input.eventType, payload, idempotencyKey],
    );

    if (rows[0]) {
      // Inside a caller's transaction the rows aren't visible until commit, so
      // waking now would find nothing; the next poll picks them up.
      if (!options.client) this.wake();
      return {
        message: toMessage(rows[0]),
        deliveryCount: rows[0].delivery_count,
        deduplicated: false,
      };
    }

    // Idempotency key already used: return the original message.
    const existing = await db.query(
      `SELECT m.*,
              (SELECT count(*) FROM ${this.t.deliveries} d WHERE d.message_id = m.id)::int AS delivery_count
       FROM ${this.t.messages} m
       WHERE m.tenant_id = $1 AND m.idempotency_key = $2`,
      [input.tenantId, idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Idempotent message vanished; retry send()");
    return {
      message: toMessage(row),
      deliveryCount: row.delivery_count,
      deduplicated: true,
    };
  }

  /** Returns the message, or `null`. */
  async getMessage(id: string): Promise<Message | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t.messages} WHERE id = $1`,
      [id],
    );
    return rows[0] ? toMessage(rows[0]) : null;
  }

  /**
   * Deletes messages created before `olderThan` whose deliveries are all
   * finished (none `pending` or `delivering`), with their deliveries and
   * attempts. Works in batches of `batchSize` (default 1000) until none are
   * left, and returns how many messages it deleted.
   * @see https://hookgres.dev/docs/guides/production#clean-up-old-rows
   */
  async cleanup(options: CleanupOptions): Promise<number> {
    const { olderThan } = options;
    const batchSize = options.batchSize ?? 1000;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error("cleanup batchSize must be a positive integer");
    }
    let cutoff: Date;
    if (olderThan instanceof Date) {
      if (Number.isNaN(olderThan.getTime())) {
        throw new Error("cleanup olderThan is an invalid Date");
      }
      cutoff = olderThan;
    } else if (Number.isFinite(olderThan) && olderThan >= 0) {
      // Use the database clock, like every other timestamp Hookgres writes.
      const { rows } = await this.pool.query<{ cutoff: Date }>(
        "SELECT now() - make_interval(secs => $1::double precision / 1000) AS cutoff",
        [olderThan],
      );
      cutoff = (rows[0] as { cutoff: Date }).cutoff;
    } else {
      throw new Error(
        "cleanup olderThan must be a Date or a non-negative number of ms",
      );
    }

    let deleted = 0;
    for (;;) {
      const { rowCount } = await this.pool.query(
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

  // ------------------------------------------------------------ deliveries

  /** Returns the delivery (one message to one endpoint), or `null`. */
  async getDelivery(id: string): Promise<Delivery | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t.deliveries} WHERE id = $1`,
      [id],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  /**
   * Lists deliveries newest first, filtered by message, endpoint or status.
   * `limit` defaults to 50 and is capped at 500.
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
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t.deliveries}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id
       LIMIT $${values.length}`,
      values,
    );
    return rows.map(toDelivery);
  }

  /** Lists every HTTP attempt of a delivery, oldest first. */
  async listAttempts(deliveryId: string): Promise<Attempt[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t.attempts} WHERE delivery_id = $1 ORDER BY created_at, attempt_number`,
      [deliveryId],
    );
    return rows.map(toAttempt);
  }

  /**
   * Re-queues a finished delivery (succeeded or failed) for immediate sending
   * with a fresh retry schedule. Returns `null` if the delivery does not exist
   * or is still in flight.
   */
  async replayDelivery(id: string): Promise<Delivery | null> {
    const { rows } = await this.pool.query(
      `UPDATE ${this.t.deliveries}
       SET status = 'pending', attempt_count = 0, next_attempt_at = now(),
           locked_until = NULL, lock_token = NULL, last_error = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('succeeded', 'failed')
         -- Blocks cleanup() from deleting the message under this replay.
         AND EXISTS (
           SELECT 1 FROM ${this.t.messages} m
           WHERE m.id = message_id
           FOR SHARE
         )
       RETURNING *`,
      [id],
    );
    if (!rows[0]) return null;
    this.wake();
    return toDelivery(rows[0]);
  }

  // ---------------------------------------------------------------- worker

  /** Starts the background delivery loop in this process. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const previous = this.loopPromise;
    this.loopPromise = (async () => {
      // If a stop() is still draining, let the old loop finish first.
      await previous;
      await this.loop(generation);
    })();
  }

  /** Stops the loop and waits for in-flight deliveries to finish. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    const loop = this.loopPromise;
    await loop;
    if (this.loopPromise === loop) this.loopPromise = null;
  }

  /** Stops the worker and closes the pool if Hookgres created it. */
  async close(): Promise<void> {
    await this.stop();
    this.closeTransport();
    if (this.ownsPool) await this.pool.end();
  }

  /**
   * Claims and sends one batch of due deliveries, then returns how many it
   * processed. Use it from a cron or serverless function instead of `start()`.
   * Always waits for every claimed delivery to finish.
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

  private async loop(generation: number): Promise<void> {
    const active = () => this.running && generation === this.generation;
    while (active()) {
      let processed = 0;
      try {
        processed = await this.runOnce();
      } catch (error) {
        try {
          this.onError(error);
        } catch {
          // A throwing onError must not kill the loop.
        }
      }
      if (active() && processed < this.concurrency) {
        await this.sleep(this.pollIntervalMs);
      }
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

  private async claim(): Promise<ClaimedDelivery[]> {
    const { rows } = await this.pool.query<ClaimedDelivery>(
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
       RETURNING d.id, d.lock_token, d.attempt_count, m.id AS message_id,
                 m.event_type, m.payload, m.created_at AS message_created_at,
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
    await this.pool.query(
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

    // Each write only applies while this worker still holds the claim
    // (lock_token), so a stale worker can't overwrite a newer result.
    if (outcome.ok) {
      await this.pool.query(
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
         )
         UPDATE ${this.t.endpoints}
         SET failing_since = NULL, updated_at = now()
         WHERE id IN (SELECT endpoint_id FROM d) AND failing_since IS NOT NULL`,
        [
          delivery.id,
          delivery.lock_token,
          attemptNumber,
          outcome.statusCode,
          responseBody,
          outcome.durationMs,
        ],
      );
      return;
    }

    const isFinal = attemptNumber > this.retrySchedule.length;
    const baseDelayMs = isFinal
      ? 0
      : (this.retrySchedule[attemptNumber - 1] ?? 0);
    const delayMs = Math.round(
      baseDelayMs * (1 + this.retryJitter * (2 * Math.random() - 1)),
    );
    await this.pool.query(
      `WITH d AS (
         UPDATE ${this.t.deliveries}
         SET status = CASE WHEN $8::boolean THEN 'failed' ELSE 'pending' END,
             next_attempt_at = now() + make_interval(secs => $9::double precision / 1000),
             locked_until = NULL,
             lock_token = NULL,
             last_error = $6,
             updated_at = now()
         WHERE id = $1 AND lock_token = $2
         RETURNING id, endpoint_id
       ), a AS (
         INSERT INTO ${this.t.attempts}
           (delivery_id, attempt_number, status_code, response_body, error, duration_ms)
         SELECT d.id, $3, $4, $5, $6, $7 FROM d
       )
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
       WHERE id IN (SELECT endpoint_id FROM d)`,
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
  }

  private async attempt(delivery: ClaimedDelivery): Promise<AttemptOutcome> {
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
      const responseBody = await readLimited(response);
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

async function queryWithNulHint(
  db: Queryable,
  text: string,
  values: unknown[],
) {
  try {
    return await db.query(text, values);
  } catch (error) {
    // 22P05 untranslatable_character: jsonb cannot store \u0000.
    if ((error as { code?: string }).code === "22P05") {
      throw new Error(
        "Payload contains a NUL character (\\u0000), which Postgres cannot store",
        { cause: error },
      );
    }
    throw error;
  }
}

function assertUrl(url: string, guard: AddressGuard | null): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid endpoint URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Endpoint URL must use http or https: ${url}`);
  }
  guard?.assertEndpointUrl(parsed);
}

function normaliseEventTypes(
  eventTypes: string[] | null | undefined,
): string[] | null {
  if (eventTypes == null) return null;
  if (eventTypes.length === 0) {
    throw new Error(
      "eventTypes must not be empty; pass null to receive every event type",
    );
  }
  for (const type of eventTypes) {
    if (type === "*") {
      throw new Error(
        'eventTypes must not contain "*"; pass null to receive every event type',
      );
    }
    if (type.includes("*") && !/^[^*]+\.\*$/.test(type)) {
      throw new Error(
        `Invalid event type pattern "${type}": "*" is only allowed as the last segment, as in "invoice.*"`,
      );
    }
  }
  return [...new Set(eventTypes)];
}

async function readLimited(
  response: TransportResponse,
): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < RESPONSE_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A body that fails mid-stream doesn't change the attempt's outcome.
  } finally {
    reader.cancel().catch(() => {});
  }
  return text.slice(0, RESPONSE_BODY_LIMIT);
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
