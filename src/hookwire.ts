import pg from "pg";
import { newId } from "./ids.js";
import { migrations } from "./migrations.js";
import { assertSecret, generateSecret, sign } from "./signing.js";
import type {
  Attempt,
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

export interface HookwireOptions {
  /** An existing `pg.Pool`. Hookwire never closes a pool it did not create. */
  pool?: pg.Pool;
  /** Alternatively, a connection string; Hookwire creates and owns the pool. */
  connectionString?: string;
  /** Postgres schema for Hookwire's tables. Defaults to `hookwire`. */
  schema?: string;
  /** Delay in ms before each retry. Its length + 1 is the max attempt count. */
  retrySchedule?: number[];
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
  /** Custom fetch, e.g. to add a proxy or an SSRF guard. */
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

export class Hookwire {
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
  private readonly requestTimeoutMs: number;
  private readonly disableEndpointAfterMs: number | null;
  private readonly pollIntervalMs: number;
  private readonly concurrency: number;
  private readonly lockTimeoutMs: number;
  private readonly secretRotationGraceMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;
  private readonly onError: (error: unknown) => void;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private wakePending = false;
  private generation = 0;

  constructor(options: HookwireOptions) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else if (options.connectionString) {
      this.pool = new pg.Pool({ connectionString: options.connectionString });
      this.ownsPool = true;
    } else {
      throw new Error("Hookwire needs either `pool` or `connectionString`");
    }

    const schema = options.schema ?? "hookwire";
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
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? "Hookwire/0.1";
    this.onError =
      options.onError ??
      ((error) => console.error("[hookwire] worker error:", error));
  }

  // ---------------------------------------------------------------- schema

  /** Creates or upgrades Hookwire's tables. Safe to run concurrently. */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `hookwire:migrate:${this.schema}`,
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

  async createEndpoint(input: CreateEndpointInput): Promise<Endpoint> {
    assertUrl(input.url);
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

  async getEndpoint(id: string): Promise<Endpoint | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t.endpoints} WHERE id = $1`,
      [id],
    );
    return rows[0] ? toEndpoint(rows[0]) : null;
  }

  async listEndpoints(tenantId: string): Promise<Endpoint[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t.endpoints} WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return rows.map(toEndpoint);
  }

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
      assertUrl(patch.url);
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
          AND (e.event_types IS NULL OR m.event_type = ANY (e.event_types))
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

  async getMessage(id: string): Promise<Message | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t.messages} WHERE id = $1`,
      [id],
    );
    return rows[0] ? toMessage(rows[0]) : null;
  }

  // ------------------------------------------------------------ deliveries

  async getDelivery(id: string): Promise<Delivery | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.t.deliveries} WHERE id = $1`,
      [id],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }

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

  /** Stops the worker and closes the pool if Hookwire created it. */
  async close(): Promise<void> {
    await this.stop();
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
    const delayMs = isFinal ? 0 : (this.retrySchedule[attemptNumber - 1] ?? 0);
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
      const response = await this.fetchFn(delivery.url, {
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

function assertUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid endpoint URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Endpoint URL must use http or https: ${url}`);
  }
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
  return [...new Set(eventTypes)];
}

async function readLimited(response: Response): Promise<string | null> {
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
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return `Timed out after ${timeoutMs}ms`;
    const cause = (error as { cause?: { code?: string; message?: string } })
      .cause;
    if (cause?.code) return `${error.message}: ${cause.code}`;
    return error.message;
  }
  return String(error);
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
