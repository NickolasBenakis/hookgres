import pg from "pg";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import {
  type AttemptEvent,
  type EndpointDisabledEvent,
  Hookgres,
  verifyWebhook,
  type WebhookEnvelope,
} from "../src/index.js";
import { migrations } from "../src/migrations.js";
import {
  closedPortUrl,
  drain,
  type Receiver,
  startReceiver,
  useHookgres,
  waitFor,
} from "./helpers.js";

const ctx = useHookgres();
let receiver: Receiver;

beforeEach(async () => {
  receiver = await startReceiver();
});
afterEach(async () => {
  await receiver.close();
});

describe("migrate", () => {
  it("is idempotent and safe to run concurrently", async () => {
    const hw = ctx.create();
    await Promise.all([hw.migrate(), hw.migrate(), hw.migrate()]);
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM "${ctx.schema}".schema_migrations`,
    );
    expect(rows[0].n).toBe(migrations.length);
  });

  /**
   * Names of the indexes on this schema's messages table that are on
   * created_at alone. Reads the catalogs directly: pg_indexes calls
   * pg_get_indexdef, which fails when other test files drop schemas at the
   * same time.
   */
  async function createdAtIndexes(schema: string): Promise<string[]> {
    const { rows } = await ctx.pool.query(
      `SELECT c.relname
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indrelid = $1::regclass AND i.indnatts = 1
         AND a.attname = 'created_at'
       ORDER BY c.relname`,
      [`"${schema}".messages`],
    );
    return rows.map((r) => r.relname);
  }

  async function schemaState(schema: string) {
    const versions = await ctx.pool.query(
      `SELECT version FROM "${schema}".schema_migrations ORDER BY version`,
    );
    return {
      versions: versions.rows.map((r) => r.version),
      indexes: await createdAtIndexes(schema),
    };
  }

  it("creates the messages (created_at) index on a fresh schema", async () => {
    const schema = `${ctx.schema}_fresh`;
    try {
      await ctx.create({ schema }).migrate();
      expect(await schemaState(schema)).toEqual({
        versions: [1, 2, 3, 4, 5],
        indexes: ["messages_created_idx"],
      });
    } finally {
      await ctx.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it("upgrades a schema created by the 0.2 migrations in place", async () => {
    const schema = `${ctx.schema}_old`;
    try {
      // What migrate() left behind before migration 2 existed.
      await ctx.pool.query(`CREATE SCHEMA "${schema}"`);
      await ctx.pool.query(
        `CREATE TABLE "${schema}".schema_migrations (
           version integer PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await ctx.pool.query(
        (migrations[0] as { sql: string }).sql.replaceAll(
          "{{schema}}",
          `"${schema}"`,
        ),
      );
      await ctx.pool.query(
        `INSERT INTO "${schema}".schema_migrations (version) VALUES (1)`,
      );

      const hw = ctx.create({ schema });
      // A message sent before the upgrade.
      await ctx.pool.query(
        `INSERT INTO "${schema}".messages (id, tenant_id, event_type, payload)
         VALUES ('msg_old', 'acme', 'e', '{"a":1}')`,
      );
      await hw.migrate();
      expect(await schemaState(schema)).toEqual({
        versions: [1, 2, 3, 4, 5],
        indexes: ["messages_created_idx"],
      });
      expect(await hw.getMessage("msg_old")).toMatchObject({
        payload: { a: 1 },
        redactedAt: null,
      });
      // The upgraded schema works, redaction included.
      const redacting = ctx.create({ schema, redactPayloads: true });
      await redacting.createEndpoint({ tenantId: "acme", url: receiver.url });
      const sent = await redacting.send({
        tenantId: "acme",
        eventType: "e",
        payload: {},
      });
      await drain(redacting);
      expect(receiver.requests).toHaveLength(1);
      expect(
        (await redacting.getMessage(sent.message.id))?.redactedAt,
      ).toBeInstanceOf(Date);
    } finally {
      await ctx.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it("skips the index if one on created_at was already built by hand", async () => {
    const schema = `${ctx.schema}_byhand`;
    try {
      const hw = ctx.create({ schema });
      await hw.migrate();
      // A 0.2 user who followed the old advice, with Postgres's default name.
      await ctx.pool.query(
        `DROP INDEX "${schema}".messages_created_idx;
         DELETE FROM "${schema}".schema_migrations WHERE version = 2;
         CREATE INDEX ON "${schema}".messages (created_at);`,
      );
      await hw.migrate();
      expect((await schemaState(schema)).versions).toEqual([1, 2, 3, 4, 5]);
      expect(await createdAtIndexes(schema)).toEqual([
        "messages_created_at_idx",
      ]);
    } finally {
      await ctx.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it("replaces an invalid index left by a failed concurrent build", async () => {
    const schema = `${ctx.schema}_invalid`;
    try {
      const hw = ctx.create({ schema });
      await hw.migrate();
      await ctx.pool.query(
        `DELETE FROM "${schema}".schema_migrations WHERE version = 2;
         UPDATE pg_index SET indisvalid = false
         WHERE indexrelid = '"${schema}".messages_created_idx'::regclass;`,
      );
      await hw.migrate();
      const { rows } = await ctx.pool.query(
        `SELECT indisvalid FROM pg_index
         WHERE indexrelid = '"${schema}".messages_created_idx'::regclass`,
      );
      expect(rows).toEqual([{ indisvalid: true }]);
    } finally {
      await ctx.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it("rejects unsafe schema names", () => {
    expect(() => ctx.create({ schema: 'x"; DROP TABLE y; --' })).toThrow(
      /Invalid schema name/,
    );
  });

  it("says to call migrate() when the tables don't exist", async () => {
    const hw = ctx.create({ schema: `${ctx.schema}_unmigrated` });
    const missing = /does not exist\. .*call `await hookgres\.migrate\(\)`/;
    await expect(hw.listEndpoints("acme")).rejects.toThrow(missing);
    await expect(
      hw.send({ tenantId: "acme", eventType: "e", payload: {} }),
    ).rejects.toThrow(missing);
    // Still Postgres's error, with its code, so existing handling keeps working.
    await expect(hw.runOnce()).rejects.toMatchObject({ code: "42P01" });
  });
});

describe("endpoints", () => {
  it("creates endpoints with a generated secret and lists them by tenant", async () => {
    const hw = ctx.create();
    const a = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.createEndpoint({ tenantId: "other", url: receiver.url });

    expect(a.id).toMatch(/^ep_/);
    expect(a.secret).toMatch(/^whsec_/);
    expect(a.eventTypes).toBeNull();
    expect((await hw.listEndpoints("acme")).map((e) => e.id)).toEqual([a.id]);
  });

  it("validates URLs and event types", async () => {
    const hw = ctx.create();
    await expect(
      hw.createEndpoint({ tenantId: "acme", url: "ftp://example.com" }),
    ).rejects.toThrow(/http or https/);
    await expect(
      hw.createEndpoint({ tenantId: "acme", url: "not a url" }),
    ).rejects.toThrow(/Invalid endpoint URL/);
    await expect(
      hw.createEndpoint({
        tenantId: "acme",
        url: receiver.url,
        eventTypes: [],
      }),
    ).rejects.toThrow(/must not be empty/);
  });

  it("updates, re-enables and deletes endpoints", async () => {
    const hw = ctx.create();
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });

    const disabled = await hw.updateEndpoint(ep.id, { disabled: true });
    expect(disabled?.disabled).toBe(true);
    expect(disabled?.disabledReason).toBe("Disabled manually");

    const enabled = await hw.updateEndpoint(ep.id, {
      disabled: false,
      eventTypes: ["a.b"],
      description: "Main",
    });
    expect(enabled).toMatchObject({
      disabled: false,
      disabledReason: null,
      eventTypes: ["a.b"],
      description: "Main",
    });

    expect(await hw.deleteEndpoint(ep.id)).toBe(true);
    expect(await hw.getEndpoint(ep.id)).toBeNull();
    expect(await hw.updateEndpoint(ep.id, { url: receiver.url })).toBeNull();
  });
});

describe("send", () => {
  it("fans out to enabled endpoints of the tenant subscribed to the event type", async () => {
    const hw = ctx.create();
    const all = await hw.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
    });
    const paid = await hw.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
      eventTypes: ["invoice.paid"],
    });
    await hw.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
      eventTypes: ["user.created"],
    });
    const off = await hw.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
    });
    await hw.updateEndpoint(off.id, { disabled: true });
    await hw.createEndpoint({ tenantId: "other", url: receiver.url });

    const result = await hw.send({
      tenantId: "acme",
      eventType: "invoice.paid",
      payload: { id: "in_1" },
    });

    expect(result.deduplicated).toBe(false);
    expect(result.deliveryCount).toBe(2);
    expect(result.message.id).toMatch(/^msg_/);
    const deliveries = await hw.listDeliveries({
      messageId: result.message.id,
    });
    expect(deliveries.map((d) => d.endpointId).sort()).toEqual(
      [all.id, paid.id].sort(),
    );
    expect(deliveries.every((d) => d.status === "pending")).toBe(true);
  });

  it("deduplicates by idempotency key per tenant", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const input = {
      tenantId: "acme",
      eventType: "invoice.paid",
      payload: { n: 1 },
      idempotencyKey: "key-1",
    };

    const first = await hw.send(input);
    const second = await hw.send({ ...input, payload: { n: 2 } });
    const otherTenant = await hw.send({ ...input, tenantId: "other" });

    expect(second.deduplicated).toBe(true);
    expect(second.message.id).toBe(first.message.id);
    expect(second.message.payload).toEqual({ n: 1 });
    expect(second.deliveryCount).toBe(1);
    expect(otherTenant.deduplicated).toBe(false);
  });

  it("joins the caller's transaction (transactional outbox)", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });

    const client = await ctx.pool.connect();
    let messageId: string;
    try {
      await client.query("BEGIN");
      const result = await hw.send(
        { tenantId: "acme", eventType: "order.created", payload: {} },
        { client },
      );
      messageId = result.message.id;
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    expect(await hw.getMessage(messageId)).toBeNull();
    expect(await hw.listDeliveries()).toEqual([]);
  });

  it("accepts non-object JSON payloads", async () => {
    const hw = ctx.create();
    const result = await hw.send({
      tenantId: "acme",
      eventType: "ping",
      payload: "hello",
    });
    expect(result.message.payload).toBe("hello");
    await expect(
      hw.send({ tenantId: "acme", eventType: "ping", payload: undefined }),
    ).rejects.toThrow(/payload/);
  });
});

describe("delivery", () => {
  it("POSTs a signed Standard Webhooks envelope", async () => {
    const hw = ctx.create();
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "invoice.paid",
      payload: { amount: 4200, currency: "eur" },
    });

    await drain(hw);

    expect(receiver.requests).toHaveLength(1);
    const request = receiver.requests[0];
    if (!request) throw new Error("no request");
    expect(request.headers["webhook-id"]).toBe(message.id);
    expect(request.headers["content-type"]).toBe("application/json");
    const envelope = verifyWebhook<WebhookEnvelope>({
      secret: ep.secret,
      headers: request.headers,
      body: request.body,
    });
    expect(envelope).toEqual({
      type: "invoice.paid",
      timestamp: message.createdAt.toISOString(),
      data: { amount: 4200, currency: "eur" },
    });

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(delivery?.status).toBe("succeeded");
    expect(delivery?.attemptCount).toBe(1);
    const attempts = await hw.listAttempts(delivery?.id ?? "");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attemptNumber: 1,
      statusCode: 200,
      responseBody: "status 200",
      error: null,
    });
  });

  it("retries failures on the schedule and records every attempt", async () => {
    const hw = ctx.create({ retrySchedule: [0, 0, 0] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = (n) => (n < 3 ? 500 : 204);
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });

    await drain(hw);

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(delivery).toMatchObject({ status: "succeeded", attemptCount: 3 });
    const attempts = await hw.listAttempts(delivery?.id ?? "");
    expect(attempts.map((a) => a.statusCode)).toEqual([500, 500, 204]);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    // Same webhook-id on every retry so receivers can deduplicate.
    expect(
      new Set(receiver.requests.map((r) => r.headers["webhook-id"])),
    ).toEqual(new Set([message.id]));
  });

  it("marks the delivery failed once the schedule is exhausted", async () => {
    const hw = ctx.create({ retrySchedule: [0, 0] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 503;
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });

    await drain(hw);

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(delivery).toMatchObject({
      status: "failed",
      attemptCount: 3,
      lastError: "HTTP 503",
    });
    expect(receiver.requests).toHaveLength(3);
  });

  it("waits for the retry delay before the next attempt", async () => {
    const hw = ctx.create({ retrySchedule: [60_000] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });

    await drain(hw);

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(delivery?.status).toBe("pending");
    expect(delivery?.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 50_000,
    );
    expect(receiver.requests).toHaveLength(1);
  });

  it("treats redirects, timeouts and connection errors as failures", async () => {
    const hw = ctx.create({
      retrySchedule: [],
      requestTimeoutMs: 200,
      lockTimeoutMs: 5000,
    });
    const redirect = await hw.createEndpoint({
      tenantId: "redirect",
      url: receiver.url,
    });
    await hw.createEndpoint({
      tenantId: "refused",
      url: await closedPortUrl(),
    });
    receiver.respond = async (n) => {
      if (n === 1) return 302;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 200;
    };

    await hw.send({ tenantId: "redirect", eventType: "e", payload: {} });
    await hw.send({ tenantId: "refused", eventType: "e", payload: {} });
    await drain(hw);
    await hw.updateEndpoint(redirect.id, { url: `${receiver.url}?slow` });
    await hw.send({ tenantId: "redirect", eventType: "e", payload: {} });
    await drain(hw);

    const errors = (await hw.listDeliveries())
      .map((d) => d.lastError ?? "")
      .sort();
    expect(errors).toHaveLength(3);
    expect(errors).toContainEqual("HTTP 302");
    expect(errors).toContainEqual("Timed out after 200ms");
    expect(errors).toContainEqual("fetch failed: ECONNREFUSED");
  });

  it("never delivers twice with competing workers", async () => {
    const workers = [ctx.create(), ctx.create(), ctx.create()];
    const first = workers[0];
    if (!first) throw new Error("no worker");
    await first.createEndpoint({ tenantId: "acme", url: receiver.url });
    for (let i = 0; i < 40; i++) {
      await first.send({ tenantId: "acme", eventType: "e", payload: { i } });
    }

    for (const hw of workers) hw.start();
    await waitFor(() => receiver.requests.length >= 40);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(receiver.requests).toHaveLength(40);
    const seen = receiver.requests.map(
      (r) => (JSON.parse(r.body) as WebhookEnvelope<{ i: number }>).data.i,
    );
    expect(new Set(seen).size).toBe(40);
  });

  it("wakes the in-process worker immediately on send", async () => {
    const hw = ctx.create({ pollIntervalMs: 60_000 });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    hw.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await waitFor(() => receiver.requests.length === 1, 2000);
  });

  it("reclaims deliveries whose lock expired (crashed worker)", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    // Simulate a worker that claimed the delivery and died.
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".deliveries
       SET status = 'delivering', attempt_count = 1, locked_until = now() - interval '1 second'`,
    );

    await drain(hw);

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(delivery).toMatchObject({ status: "succeeded", attemptCount: 2 });
    expect(receiver.requests).toHaveLength(1);
  });
});

describe("endpoint health", () => {
  it("disables an endpoint after failing for disableEndpointAfterMs", async () => {
    const hw = ctx.create({ retrySchedule: [], disableEndpointAfterMs: 0 });
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;

    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);

    const after = await hw.getEndpoint(ep.id);
    expect(after?.disabled).toBe(true);
    expect(after?.disabledReason).toMatch(/Disabled automatically/);
    // Disabled endpoints get no new deliveries.
    const next = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    expect(next.deliveryCount).toBe(0);
  });

  it("keeps an endpoint enabled within the window and resets on success", async () => {
    const hw = ctx.create({
      retrySchedule: [0],
      disableEndpointAfterMs: 60_000,
    });
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = (n) => (n === 1 ? 500 : 200);

    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await hw.runOnce();
    expect((await hw.getEndpoint(ep.id))?.failingSince).toBeInstanceOf(Date);

    await drain(hw);
    const after = await hw.getEndpoint(ep.id);
    expect(after?.disabled).toBe(false);
    expect(after?.failingSince).toBeNull();
  });

  it("fails the queued deliveries of an endpoint the moment it is disabled automatically", async () => {
    // retrySchedule leaves retries, so only the disabling can fail these.
    const hw = ctx.create({
      retrySchedule: [60_000],
      disableEndpointAfterMs: 0,
      concurrency: 1,
    });
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    const first = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    const queued = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    await hw.createEndpoint({ tenantId: "globex", url: receiver.url });
    const other = await hw.send({
      tenantId: "globex",
      eventType: "e",
      payload: {},
    });

    await hw.runOnce(); // one attempt: fails and disables the endpoint

    expect((await hw.getEndpoint(ep.id))?.disabled).toBe(true);
    const [attempted] = await hw.listDeliveries({
      messageId: first.message.id,
    });
    expect(attempted).toMatchObject({
      status: "failed",
      attemptCount: 1,
      lastError: "HTTP 500",
    });
    const [waiting] = await hw.listDeliveries({ messageId: queued.message.id });
    expect(waiting).toMatchObject({
      status: "failed",
      attemptCount: 0,
      lastError: "Endpoint is disabled",
    });

    // Other endpoints' deliveries are untouched.
    const [untouched] = await hw.listDeliveries({
      messageId: other.message.id,
    });
    expect(untouched).toMatchObject({ status: "pending", attemptCount: 0 });

    // Re-enabling doesn't resend what failed while it was down.
    receiver.respond = () => 200;
    await hw.updateEndpoint(ep.id, { disabled: false });
    await drain(hw);
    expect(receiver.requests).toHaveLength(2); // acme's first try, then globex
    const [sent] = await hw.listDeliveries({ messageId: other.message.id });
    expect(sent?.status).toBe("succeeded");
  });

  it("fails an attempt recorded after its endpoint was disabled automatically", async () => {
    const rec: EndpointDisabledEvent[] = [];
    const hw = ctx.create({
      retrySchedule: [60_000],
      disableEndpointAfterMs: 60_000,
      onEndpointDisabled: (event) => {
        rec.push(event);
      },
    });
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = async () => {
      // Another worker disables the endpoint while this request is in flight.
      await ctx.pool.query(
        `UPDATE "${ctx.schema}".endpoints
         SET disabled = true, disabled_reason = 'Disabled automatically: test'
         WHERE id = $1`,
        [ep.id],
      );
      return 500;
    };
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    await hw.runOnce();

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(delivery).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(rec).toEqual([]); // reported by the worker that disabled it
  });

  it("keeps retrying deliveries of a manually paused endpoint", async () => {
    const hw = ctx.create({
      retrySchedule: [60_000],
      disableEndpointAfterMs: 0,
      concurrency: 1,
    });
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = async () => {
      // Paused while this request is in flight.
      await hw.updateEndpoint(ep.id, { disabled: true });
      return 500;
    };
    const first = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    const queued = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    await hw.runOnce();

    const [attempted] = await hw.listDeliveries({
      messageId: first.message.id,
    });
    expect(attempted).toMatchObject({ status: "pending", attemptCount: 1 });
    const [waiting] = await hw.listDeliveries({ messageId: queued.message.id });
    expect(waiting).toMatchObject({ status: "pending", attemptCount: 0 });
    expect((await hw.getEndpoint(ep.id))?.disabledReason).toBe(
      "Disabled manually",
    );
  });

  it("fails every delivery in flight when their endpoint is disabled", async () => {
    const hw = ctx.create({
      retrySchedule: [60_000],
      disableEndpointAfterMs: 0,
    });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });

    await hw.runOnce(); // both claimed and sent in one batch

    expect(receiver.requests).toHaveLength(2);
    const deliveries = await hw.listDeliveries();
    expect(deliveries.map((d) => [d.status, d.attemptCount])).toEqual([
      ["failed", 1],
      ["failed", 1],
    ]);
  });

  it("fails pending deliveries of an endpoint disabled after queuing", async () => {
    const hw = ctx.create();
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    await hw.updateEndpoint(ep.id, { disabled: true });

    await drain(hw);

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(delivery).toMatchObject({
      status: "failed",
      lastError: "Endpoint is disabled",
      attemptCount: 0, // no HTTP attempt was made
    });
    expect(receiver.requests).toHaveLength(0);
  });
});

describe("fairness", () => {
  it("doesn't let one endpoint's slow backlog hold up other tenants", async () => {
    const slow = await startReceiver();
    try {
      slow.respond = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return 200;
      };
      const hw = ctx.create({ concurrency: 4, requestTimeoutMs: 5000 });
      await hw.createEndpoint({ tenantId: "noisy", url: slow.url });
      await hw.createEndpoint({ tenantId: "quiet", url: receiver.url });
      for (let i = 0; i < 40; i++) {
        await hw.send({ tenantId: "noisy", eventType: "e", payload: { i } });
      }
      await hw.send({ tenantId: "quiet", eventType: "e", payload: {} });
      const started = Date.now();
      hw.start();
      // FIFO without the per-endpoint cap: 40 slow deliveries / 4 slots = 10s.
      await waitFor(() => receiver.requests.length === 1, 3000);
      expect(Date.now() - started).toBeLessThan(2500);
      await hw.stop();
    } finally {
      await slow.close();
    }
  });

  it("serves another tenant behind a backlog much bigger than the claim window", async () => {
    const slow = await startReceiver();
    try {
      slow.respond = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return 200;
      };
      const hw = ctx.create({ concurrency: 4, requestTimeoutMs: 5000 });
      await hw.createEndpoint({ tenantId: "noisy", url: slow.url });
      await hw.createEndpoint({ tenantId: "quiet", url: receiver.url });
      await ctx.pool.query(
        `WITH m AS (
           INSERT INTO "${ctx.schema}".messages (id, tenant_id, event_type, payload)
           SELECT 'msg_bulk_' || g, 'noisy', 'e', '{}' FROM generate_series(1, 2000) g
           RETURNING id
         )
         INSERT INTO "${ctx.schema}".deliveries (message_id, endpoint_id)
         SELECT m.id, e.id FROM m, "${ctx.schema}".endpoints e WHERE e.tenant_id = 'noisy'`,
      );
      await hw.send({ tenantId: "quiet", eventType: "e", payload: {} });
      const started = Date.now();
      hw.start();
      await waitFor(() => receiver.requests.length === 1, 4000);
      expect(Date.now() - started).toBeLessThan(3000);
      await hw.stop();
    } finally {
      await slow.close();
    }
  });

  it("still serves other tenants after the wall clock steps back", async () => {
    const slow = await startReceiver();
    const realNow = Date.now;
    try {
      slow.respond = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return 200;
      };
      const hw = ctx.create({ concurrency: 4, requestTimeoutMs: 5000 });
      await hw.createEndpoint({ tenantId: "noisy", url: slow.url });
      await hw.createEndpoint({ tenantId: "quiet", url: receiver.url });
      for (let i = 0; i < 100; i++) {
        await hw.send({ tenantId: "noisy", eventType: "e", payload: { i } });
      }
      hw.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      Date.now = () => realNow() - 60 * 60 * 1000; // NTP steps the clock back
      await hw.send({ tenantId: "quiet", eventType: "e", payload: {} });
      await waitFor(() => receiver.requests.length === 1, 4000);
      await hw.stop();
    } finally {
      Date.now = realNow;
      await slow.close();
    }
  });

  it("doesn't end concurrent drains early while work is due", async () => {
    const one = ctx.create({ concurrency: 5 });
    const two = ctx.create({ concurrency: 5 });
    await one.createEndpoint({ tenantId: "a", url: receiver.url });
    await one.createEndpoint({ tenantId: "b", url: receiver.url });
    for (let i = 0; i < 60; i++) {
      await one.send({
        tenantId: i % 2 ? "a" : "b",
        eventType: "e",
        payload: { i },
      });
    }
    const [x, y] = await Promise.all([
      one.drain({ timeoutMs: 10_000 }),
      two.drain({ timeoutMs: 10_000 }),
    ]);
    expect(x + y).toBe(60);
    expect(await one.listDeliveries({ status: "pending" })).toEqual([]);
  });

  it("keeps at most maxInFlightPerEndpoint deliveries to one endpoint in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    receiver.respond = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight--;
      return 200;
    };
    const hw = ctx.create({ concurrency: 10, maxInFlightPerEndpoint: 3 });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    for (let i = 0; i < 30; i++) {
      await hw.send({ tenantId: "acme", eventType: "e", payload: { i } });
    }
    hw.start();
    await waitFor(() => receiver.requests.length === 30, 5000);
    await hw.stop();
    expect(peak).toBe(3);
    // Rows over the share went back to pending without spending an attempt.
    const deliveries = await hw.listDeliveries({ limit: 30 });
    expect(deliveries.every((d) => d.attemptCount === 1)).toBe(true);
  });
});

describe("payload loading", () => {
  it("sends one fanned-out message's body, unchanged, to each endpoint", async () => {
    const hw = ctx.create({
      concurrency: 5,
      maxInFlightPerEndpoint: 5,
    });
    for (let i = 0; i < 5; i++) {
      await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    }
    await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: { big: "x".repeat(1000), n: 1.5 },
    });
    expect(await hw.runOnce()).toBe(5);
    const bodies = new Set(receiver.requests.map((r) => r.body));
    expect(bodies.size).toBe(1);
    const envelope = JSON.parse([...bodies][0] ?? "") as WebhookEnvelope<{
      n: number;
    }>;
    expect(envelope.data.n).toBe(1.5);
  });
});

describe("caller clients", () => {
  it("handles a client that maps result columns to camelCase", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const camel = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
          v,
        ]),
      );
    // Like Knex with knexSnakeCaseMappers (postProcessResponse).
    const client = {
      async query(text: string, values?: unknown[]) {
        const result = await ctx.pool.query(text, values);
        return { ...result, rows: result.rows.map(camel) };
      },
    } as unknown as pg.PoolClient;
    for (const idempotencyKey of [undefined, "k1", "k1"]) {
      const result = await hw.send(
        { tenantId: "acme", eventType: "e", payload: { a: 1 }, idempotencyKey },
        { client },
      );
      expect(result.message.tenantId).toBe("acme");
      expect(result.message.createdAt).toBeInstanceOf(Date);
      expect(Number.isNaN(result.message.createdAt.getTime())).toBe(false);
      expect(result.deliveryCount).toBe(1);
    }
  });
});

describe("non-ISO DateStyle", () => {
  it("still cleans up and sends real timestamps", async () => {
    const german = new pg.Pool({
      connectionString: inject("databaseUrl"),
      options: "-c datestyle=German",
    });
    try {
      const hw = ctx.create({ pool: german });
      await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
      const before = Date.now();
      const { message } = await hw.send({
        tenantId: "acme",
        eventType: "e",
        payload: {},
      });
      await drain(hw);
      const envelope = JSON.parse(
        receiver.requests[0]?.body ?? "{}",
      ) as WebhookEnvelope;
      expect(Date.parse(envelope.timestamp)).toBeGreaterThan(before - 60_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await hw.cleanup({ olderThan: 1 })).toBeGreaterThanOrEqual(1);
      expect(await hw.getMessage(message.id)).toBeNull();
    } finally {
      await german.end();
    }
  });
});

describe("locking", () => {
  async function openSend(hw: Hookgres, tenantId: string) {
    const client = await ctx.pool.connect();
    await client.query("BEGIN");
    await hw.send({ tenantId, eventType: "e", payload: {} }, { client });
    return client;
  }

  it("records a failed attempt while an app transaction that sent to the endpoint is open", async () => {
    const hw = ctx.create({ retrySchedule: [60_000] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    // Holds FOR KEY SHARE on the endpoint through the deliveries foreign key.
    const client = await openSend(hw, "acme");
    try {
      const started = Date.now();
      const processed = await Promise.race([
        hw.runOnce(),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 2000)),
      ]);
      expect(processed).toBe(1);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("doesn't deadlock workers recording failures while sends run", async () => {
    const errors: unknown[] = [];
    const options = {
      retrySchedule: [0, 0, 0, 0, 0, 0, 0, 0],
      disableEndpointAfterMs: null,
      concurrency: 10,
      maxInFlightPerEndpoint: 10,
      onError: (error: unknown) => {
        errors.push(error);
      },
    };
    const workers = [
      ctx.create(options),
      ctx.create(options),
      ctx.create(options),
    ];
    await workers[0]?.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    for (const w of workers) w.start();
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      await workers[0]?.send({ tenantId: "acme", eventType: "e", payload: {} });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await Promise.all(workers.map((w) => w.stop()));
    const deadlocks = errors.filter(
      (e) => (e as { code?: string }).code === "40P01",
    );
    expect(deadlocks).toEqual([]);
  });

  it("send() doesn't fail when another endpoint of the tenant is deleted meanwhile", async () => {
    const hw = ctx.create();
    const doomed = await hw.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
    });
    const kept = await hw.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
    });
    // The delete holds the endpoint row until it commits.
    const deleter = await ctx.pool.connect();
    await deleter.query("BEGIN");
    await deleter.query(`DELETE FROM "${ctx.schema}".endpoints WHERE id = $1`, [
      doomed.id,
    ]);
    const sending = hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await deleter.query("COMMIT");
    deleter.release();

    const result = await sending;
    expect(result.deliveryCount).toBe(1);
    const deliveries = await hw.listDeliveries({
      messageId: result.message.id,
    });
    expect(deliveries.map((d) => d.endpointId)).toEqual([kept.id]);
  });

  it("deleteEndpoint() doesn't deadlock with a worker recording failures", async () => {
    const hw = ctx.create({ retrySchedule: [0, 0, 0], concurrency: 20 });
    receiver.respond = () => 500;
    for (let round = 0; round < 8; round++) {
      const ep = await hw.createEndpoint({
        tenantId: "acme",
        url: receiver.url,
      });
      await Promise.all(
        Array.from({ length: 20 }, () =>
          hw.send({ tenantId: "acme", eventType: "e", payload: {} }),
        ),
      );
      const working = hw.runOnce();
      await new Promise((resolve) => setTimeout(resolve, round * 3));
      await expect(hw.deleteEndpoint(ep.id)).resolves.toBe(true);
      await working;
    }
  });
});

describe("worker database timeouts", () => {
  it("gives up on a stuck worker query after lockTimeoutMs and keeps going", async () => {
    const errors: unknown[] = [];
    const hw = ctx.create({
      retrySchedule: [60_000],
      requestTimeoutMs: 500,
      lockTimeoutMs: 1000,
      onError: (error) => {
        errors.push(error);
      },
    });
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    // Stands in for a query stuck on a dead connection: recording the failed
    // attempt waits for this lock.
    const locker = await ctx.pool.connect();
    await locker.query("BEGIN");
    await locker.query(
      `SELECT 1 FROM "${ctx.schema}".endpoints WHERE id = $1 FOR UPDATE`,
      [ep.id],
    );
    try {
      const outcome = await Promise.race([
        hw.runOnce().then(() => "returned"),
        new Promise((resolve) => setTimeout(() => resolve("stuck"), 4000)),
      ]);
      expect(outcome).toBe("returned");
      expect(String(errors[0])).toMatch(/timeout/i);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    // The timed-out statement was cancelled on the server too: it didn't
    // record the attempt once the lock was released.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM "${ctx.schema}".attempts`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("cancels a timed-out query even when the pool has no spare connection", async () => {
    // The worker's only connection is the one that timed out: the cancel
    // mustn't wait for a second one that never comes.
    const tinyPool = new pg.Pool({
      connectionString: inject("databaseUrl"),
      max: 1,
    });
    tinyPool.on("error", () => {});
    try {
      const hw = ctx.create({
        pool: tinyPool,
        retrySchedule: [60_000],
        requestTimeoutMs: 500,
        lockTimeoutMs: 1000,
        onError: () => {},
      });
      const ep = await hw.createEndpoint({
        tenantId: "acme",
        url: receiver.url,
      });
      receiver.respond = () => 500;
      await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
      const locker = await ctx.pool.connect();
      await locker.query("BEGIN");
      await locker.query(
        `SELECT 1 FROM "${ctx.schema}".endpoints WHERE id = $1 FOR UPDATE`,
        [ep.id],
      );
      try {
        const outcome = await Promise.race([
          hw.runOnce().then(() => "returned"),
          new Promise((resolve) => setTimeout(() => resolve("stuck"), 6000)),
        ]);
        expect(outcome).toBe("returned");
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { rows } = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM "${ctx.schema}".attempts`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await tinyPool.end();
    }
  });

  it("cancels timed-out queries while others queue for the only connection", async () => {
    const tinyPool = new pg.Pool({
      connectionString: inject("databaseUrl"),
      max: 1,
    });
    tinyPool.on("error", () => {});
    try {
      const hw = ctx.create({
        pool: tinyPool,
        concurrency: 2,
        retrySchedule: [60_000],
        requestTimeoutMs: 500,
        lockTimeoutMs: 1000,
        onError: () => {},
      });
      const a = await hw.createEndpoint({ tenantId: "a", url: receiver.url });
      const b = await hw.createEndpoint({ tenantId: "b", url: receiver.url });
      receiver.respond = () => 500;
      await hw.send({ tenantId: "a", eventType: "e", payload: {} });
      await hw.send({ tenantId: "b", eventType: "e", payload: {} });
      const locker = await ctx.pool.connect();
      await locker.query("BEGIN");
      await locker.query(
        `SELECT 1 FROM "${ctx.schema}".endpoints WHERE id = ANY($1) FOR UPDATE`,
        [[a.id, b.id]],
      );
      try {
        await Promise.race([
          hw.runOnce(),
          new Promise((resolve) => setTimeout(resolve, 8000)),
        ]);
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { rows } = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM "${ctx.schema}".attempts`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await tinyPool.end();
    }
  });

  it("puts claimed deliveries back when preparing them fails", async () => {
    const hw = ctx.create({ onError: () => {} });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    (hw as unknown as { loadBodies: () => Promise<void> }).loadBodies =
      async () => {
        throw new Error("boom");
      };
    await expect(hw.runOnce()).rejects.toThrow("boom");
    const { rows } = await ctx.pool.query(
      `SELECT status, attempt_count, lock_token FROM "${ctx.schema}".deliveries`,
    );
    expect(rows).toEqual([
      { status: "pending", attempt_count: 0, lock_token: null },
    ]);
  });

  it("returns Date objects even when the pool parses timestamps as strings", async () => {
    const stringPool = new pg.Pool({
      connectionString: inject("databaseUrl"),
      types: {
        getTypeParser: (oid: number, format?: string) =>
          oid === 1184
            ? (value: string) => value
            : pg.types.getTypeParser(oid, format as "text"),
      } as pg.CustomTypesConfig,
    });
    try {
      const attempts: AttemptEvent[] = [];
      const hw = ctx.create({
        pool: stringPool,
        retrySchedule: [60_000],
        onAttempt: (event) => {
          attempts.push(event);
        },
      });
      const ep = await hw.createEndpoint({
        tenantId: "acme",
        url: receiver.url,
      });
      receiver.respond = () => 500;
      const { message } = await hw.send({
        tenantId: "acme",
        eventType: "e",
        payload: {},
      });
      await hw.runOnce();
      const [delivery] = await hw.listDeliveries({ messageId: message.id });
      const [attempt] = await hw.listAttempts(delivery?.id ?? "");
      for (const value of [
        ep.createdAt,
        ep.updatedAt,
        delivery?.nextAttemptAt,
        delivery?.createdAt,
        attempt?.createdAt,
        attempts[0]?.nextAttemptAt,
      ]) {
        expect(value).toBeInstanceOf(Date);
      }
    } finally {
      await stringPool.end();
    }
  });

  it("keeps connections it creates alive and bounded", () => {
    const hw = new Hookgres({ connectionString: inject("databaseUrl") });
    const options = hw.pool.options as pg.PoolConfig;
    expect(options.keepAlive).toBe(true);
    expect(options.keepAliveInitialDelayMillis).toBe(10_000);
    return hw.close();
  });
});

describe("secret rotation", () => {
  it("signs with both secrets during the grace period, then only the new one", async () => {
    const hw = ctx.create();
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const rotated = await hw.rotateEndpointSecret(ep.id);
    expect(rotated?.secret).not.toBe(ep.secret);

    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);
    const first = receiver.requests[0];
    if (!first || !rotated) throw new Error("missing");
    for (const secret of [ep.secret, rotated.secret]) {
      expect(() =>
        verifyWebhook({ secret, headers: first.headers, body: first.body }),
      ).not.toThrow();
    }

    const again = await hw.rotateEndpointSecret(ep.id, { graceMs: 0 });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);
    const second = receiver.requests[1];
    if (!second || !again) throw new Error("missing");
    expect(String(second.headers["webhook-signature"]).split(" ")).toHaveLength(
      1,
    );
    expect(() =>
      verifyWebhook({
        secret: again.secret,
        headers: second.headers,
        body: second.body,
      }),
    ).not.toThrow();
  });
});

describe("replay", () => {
  it("re-queues a finished delivery with a fresh schedule", async () => {
    const hw = ctx.create({ retrySchedule: [] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = (n) => (n === 1 ? 500 : 200);
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    await drain(hw);
    const [failed] = await hw.listDeliveries({ messageId: message.id });
    expect(failed?.status).toBe("failed");

    const replayed = await hw.replayDelivery(failed?.id ?? "");
    expect(replayed).toMatchObject({ status: "pending", attemptCount: 0 });
    await drain(hw);

    const after = await hw.getDelivery(failed?.id ?? "");
    expect(after?.status).toBe("succeeded");
    expect(await hw.listAttempts(failed?.id ?? "")).toHaveLength(2);
  });

  it("refuses to replay pending deliveries", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    const [pending] = await hw.listDeliveries({ messageId: message.id });
    expect(await hw.replayDelivery(pending?.id ?? "")).toBeNull();
  });
});

describe("review regressions", () => {
  it("stores binary response bodies containing NUL without looping", async () => {
    const hw = ctx.create({
      fetch: async () =>
        new Response(new Uint8Array([0x47, 0x49, 0x46, 0x00, 0x01]), {
          status: 200,
        }),
    });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });

    await drain(hw);

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(delivery?.status).toBe("succeeded");
    const [attempt] = await hw.listAttempts(delivery?.id ?? "");
    expect(attempt?.responseBody).toBe("GIF\u0001");
  });

  it("rejects payloads Postgres cannot store with a clear error", async () => {
    const hw = ctx.create();
    await expect(
      hw.send({ tenantId: "acme", eventType: "e", payload: { s: "a\u0000b" } }),
    ).rejects.toThrow(/NUL character/);
  });

  it("fails a reclaimed delivery that already used its last attempt", async () => {
    const hw = ctx.create({ retrySchedule: [0] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    // A worker died during attempt 2 of 2.
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".deliveries
       SET status = 'delivering', attempt_count = 2, locked_until = now() - interval '1 second'`,
    );

    await drain(hw);

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(delivery?.status).toBe("failed");
    expect(delivery?.lastError).toMatch(/Exceeded max attempts/);
    expect(delivery?.attemptCount).toBe(2);
    expect(receiver.requests).toHaveLength(0);
  });

  it("ignores the result of a stale worker whose claim was taken over", async () => {
    let releaseStale: (() => void) | undefined;
    const staleFetch: typeof fetch = async () => {
      await new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      return new Response("stale", { status: 500 });
    };
    const stale = ctx.create({ fetch: staleFetch, retrySchedule: [0, 0] });
    const fresh = ctx.create();
    await stale.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await stale.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });

    const staleRun = stale.runOnce();
    await waitFor(() => releaseStale !== undefined);
    // The stale worker's lock expires; another worker takes over and succeeds.
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".deliveries SET locked_until = now() - interval '1 second'`,
    );
    await drain(fresh);
    // Even after a replay resets attempt_count, the stale result must not land.
    const [done] = await fresh.listDeliveries({ messageId: message.id });
    await fresh.replayDelivery(done?.id ?? "");
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".deliveries SET status = 'delivering', attempt_count = 1,
         lock_token = gen_random_uuid(), locked_until = now() + interval '1 minute'`,
    );
    releaseStale?.();
    await staleRun;

    const [after] = await fresh.listDeliveries({ messageId: message.id });
    expect(after?.status).toBe("delivering");
    expect(after?.lastError).toBeNull();
    const attempts = await fresh.listAttempts(after?.id ?? "");
    expect(attempts.map((a) => a.statusCode)).toEqual([200]);
  });

  it("rejects malformed custom secrets up front", async () => {
    const hw = ctx.create();
    for (const secret of ["mysecret", "whsec_!!", "whsec_c2hvcnQ="]) {
      await expect(
        hw.createEndpoint({ tenantId: "acme", url: receiver.url, secret }),
      ).rejects.toThrow(/Invalid webhook secret/);
    }
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await expect(
      hw.rotateEndpointSecret(ep.id, { secret: "nope" }),
    ).rejects.toThrow(/Invalid webhook secret/);
  });

  it("survives stop() followed immediately by start()", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    hw.start();
    const stopping = hw.stop();
    hw.start();
    await stopping;

    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await waitFor(() => receiver.requests.length === 1, 2000);
    await hw.stop();
  });

  it("wakes the worker when send() lands during an active pass", async () => {
    const hw = ctx.create({ pollIntervalMs: 60_000, concurrency: 5 });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    let sent = false;
    receiver.respond = async () => {
      if (!sent) {
        sent = true;
        // Arrives while the worker is mid-pass, not sleeping.
        await hw.send({ tenantId: "acme", eventType: "second", payload: {} });
      }
      return 200;
    };
    hw.start();
    await hw.send({ tenantId: "acme", eventType: "first", payload: {} });
    await waitFor(() => receiver.requests.length === 2, 2000);
  });
});

describe("configuration and edge cases", () => {
  it("creates and closes its own pool from a connection string", async () => {
    const hw = new Hookgres({
      connectionString: inject("databaseUrl"),
      schema: ctx.schema,
    });
    hw.start();
    hw.start(); // second start is a no-op
    expect(await hw.listEndpoints("nobody")).toEqual([]);
    await hw.close();
    expect(hw.pool.ended).toBe(true);
  });

  it("reports idle-client errors on its own pool instead of crashing", async () => {
    const errors: unknown[] = [];
    const hw = new Hookgres({
      connectionString: inject("databaseUrl"),
      schema: ctx.schema,
      onError: (error) => errors.push(error),
    });
    // node-postgres emits "error" on the pool when an idle client's connection
    // drops (a restart or failover). With no listener, Node throws.
    const lost = new Error("Connection terminated unexpectedly");
    expect(() => hw.pool.emit("error", lost)).not.toThrow();
    expect(errors).toEqual([lost]);
    await hw.close();
  });

  it("does not close a pool it was given", async () => {
    const hw = ctx.create();
    await hw.close();
    expect(ctx.pool.ended).toBe(false);
  });

  it("validates constructor options", () => {
    expect(() => new Hookgres({})).toThrow(/pool.*connectionString/);
    expect(() => ctx.create({ retrySchedule: [5, -1] })).toThrow(
      /non-negative/,
    );
    expect(() =>
      ctx.create({ requestTimeoutMs: 10_000, lockTimeoutMs: 5_000 }),
    ).toThrow(/lockTimeoutMs/);
    const tiny = new pg.Pool({ max: 1 });
    expect(() => new Hookgres({ pool: tiny, notify: true })).toThrow(
      /max of at least 2/,
    );
    expect(() => new Hookgres({ pool: tiny })).not.toThrow();
  });

  it("returns null or false for unknown ids", async () => {
    const hw = ctx.create();
    expect(await hw.getEndpoint("ep_missing")).toBeNull();
    expect(await hw.getMessage("msg_missing")).toBeNull();
    expect(await hw.getDelivery("dlv_missing")).toBeNull();
    expect(await hw.deleteEndpoint("ep_missing")).toBe(false);
    expect(await hw.rotateEndpointSecret("ep_missing")).toBeNull();
    expect(await hw.replayDelivery("dlv_missing")).toBeNull();
  });

  it("updates metadata and treats an empty patch as a read", async () => {
    const hw = ctx.create();
    const ep = await hw.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
      metadata: { plan: "free" },
    });
    const updated = await hw.updateEndpoint(ep.id, {
      metadata: { plan: "pro" },
    });
    expect(updated?.metadata).toEqual({ plan: "pro" });
    expect((await hw.updateEndpoint(ep.id, {}))?.id).toBe(ep.id);
  });

  it("filters deliveries by endpoint and status", async () => {
    const hw = ctx.create({ retrySchedule: [] });
    const ok = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const bad = await hw.createEndpoint({
      tenantId: "acme",
      url: await closedPortUrl(),
    });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);

    const failed = await hw.listDeliveries({ status: "failed" });
    expect(failed.map((d) => d.endpointId)).toEqual([bad.id]);
    const byEndpoint = await hw.listDeliveries({ endpointId: ok.id });
    expect(byEndpoint.map((d) => d.status)).toEqual(["succeeded"]);
  });

  it("records DNS failures with their reason", async () => {
    const hw = ctx.create({ retrySchedule: [] });
    await hw.createEndpoint({
      tenantId: "acme",
      url: "http://does-not-exist.invalid/hook",
    });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);
    const [delivery] = await hw.listDeliveries();
    // EAI_AGAIN on machines without a resolver.
    expect(delivery?.lastError).toMatch(
      /^fetch failed: (ENOTFOUND|EAI_AGAIN)$/,
    );
  });

  it("surfaces errors from runOnce when onError rethrows", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    // Break the attempts table so recording the result fails.
    await ctx.pool.query(
      `ALTER TABLE "${ctx.schema}".attempts ADD CONSTRAINT boom CHECK (false) NOT VALID`,
    );
    try {
      await expect(hw.runOnce()).rejects.toThrow(/boom/);
    } finally {
      await ctx.pool.query(
        `ALTER TABLE "${ctx.schema}".attempts DROP CONSTRAINT boom`,
      );
    }
  });
});

describe("cleanup", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function backdate(ids: string[], days: number) {
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".messages
       SET created_at = now() - make_interval(days => $2)
       WHERE id = ANY ($1)`,
      [ids, days],
    );
  }

  async function messageIds(): Promise<string[]> {
    const { rows } = await ctx.pool.query(
      `SELECT id FROM "${ctx.schema}".messages ORDER BY id`,
    );
    return rows.map((r) => r.id);
  }

  it("deletes old finished messages in batches and keeps unfinished ones", async () => {
    const hw = ctx.create({ retrySchedule: [] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = (n) => (n === 2 ? 500 : 200);
    const send = async (tenantId = "acme") =>
      (await hw.send({ tenantId, eventType: "e", payload: {} })).message.id;

    const finished = [await send(), await send(), await send()];
    const noDeliveries = await send("nobody");
    const recent = await send();
    await drain(hw);
    const pending = await send();
    const inFlight = await send();
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".deliveries SET status = 'delivering' WHERE message_id = $1`,
      [inFlight],
    );
    await backdate([...finished, noDeliveries, pending, inFlight], 40);
    const [oldDelivery] = await hw.listDeliveries({ messageId: finished[0] });

    const deleted = await hw.cleanup({ olderThan: 30 * DAY_MS, batchSize: 2 });

    expect(deleted).toBe(4);
    expect(await messageIds()).toEqual([recent, pending, inFlight].sort());
    expect(await hw.getDelivery(oldDelivery?.id as string)).toBeNull();
    expect(await hw.listAttempts(oldDelivery?.id as string)).toEqual([]);
    expect(await hw.cleanup({ olderThan: 30 * DAY_MS })).toBe(0);
  });

  it("accepts a Date cutoff", async () => {
    const hw = ctx.create();
    const a = await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    const b = await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await backdate([a.message.id], 10);

    const cutoff = new Date(Date.now() - 5 * DAY_MS);
    expect(await hw.cleanup({ olderThan: cutoff })).toBe(1);
    expect(await messageIds()).toEqual([b.message.id]);
  });

  it("validates its options", async () => {
    const hw = ctx.create();
    await expect(hw.cleanup({ olderThan: -1 })).rejects.toThrow(/olderThan/);
    await expect(
      hw.cleanup({ olderThan: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/olderThan/);
    await expect(hw.cleanup({ olderThan: new Date("nope") })).rejects.toThrow(
      /invalid Date/,
    );
    await expect(hw.cleanup({ olderThan: 0, batchSize: 0 })).rejects.toThrow(
      /batchSize/,
    );
    await expect(hw.cleanup({ olderThan: 0, batchSize: 1.5 })).rejects.toThrow(
      /batchSize/,
    );
  });
});

describe("retry jitter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Fails one attempt and returns the scheduled delay in ms. */
  async function scheduledDelay(hw: Hookgres): Promise<number> {
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    await hw.runOnce();
    // next_attempt_at and updated_at are both set from the same now().
    const { rows } = await ctx.pool.query(
      `SELECT extract(epoch FROM next_attempt_at - updated_at) * 1000 AS ms
       FROM "${ctx.schema}".deliveries WHERE message_id = $1`,
      [message.id],
    );
    return Math.round(Number(rows[0].ms));
  }

  it("spreads the delay by up to the jitter fraction (default 0.1)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(await scheduledDelay(ctx.create({ retrySchedule: [60_000] }))).toBe(
      54_000,
    );
  });

  it("uses the upper end of the range", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    const hw = ctx.create({ retrySchedule: [60_000], retryJitter: 0.5 });
    expect(await scheduledDelay(hw)).toBe(75_000);
  });

  it("keeps the exact delay when disabled", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const hw = ctx.create({ retrySchedule: [60_000], retryJitter: 0 });
    expect(await scheduledDelay(hw)).toBe(60_000);
  });

  it("keeps a zero delay at zero", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const hw = ctx.create({ retrySchedule: [0], retryJitter: 1 });
    expect(await scheduledDelay(hw)).toBe(0);
  });

  it("stays within range with real randomness", async () => {
    const delay = await scheduledDelay(
      ctx.create({ retrySchedule: [60_000], retryJitter: 0.2 }),
    );
    expect(delay).toBeGreaterThanOrEqual(48_000);
    expect(delay).toBeLessThanOrEqual(72_000);
  });

  it("validates the option", () => {
    for (const retryJitter of [-0.1, 1.1, Number.NaN]) {
      expect(() => ctx.create({ retryJitter })).toThrow(/retryJitter/);
    }
    expect(() => ctx.create({ retryJitter: 1 })).not.toThrow();
  });
});

describe("wildcard event types", () => {
  it("matches any event type under the prefix, at any depth", async () => {
    const hw = ctx.create();
    const invoices = await hw.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
      eventTypes: ["invoice.*"],
    });
    const lines = await hw.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
      eventTypes: ["user.created", "invoice.line.*"],
    });
    const endpointsFor = async (eventType: string) => {
      const { message } = await hw.send({
        tenantId: "acme",
        eventType,
        payload: {},
      });
      const deliveries = await hw.listDeliveries({ messageId: message.id });
      return deliveries.map((d) => d.endpointId).sort();
    };

    expect(await endpointsFor("invoice.paid")).toEqual([invoices.id]);
    expect(await endpointsFor("invoice.line.created")).toEqual(
      [invoices.id, lines.id].sort(),
    );
    expect(await endpointsFor("user.created")).toEqual([lines.id]);
    expect(await endpointsFor("invoice")).toEqual([]);
    expect(await endpointsFor("invoices.paid")).toEqual([]);
    expect(await endpointsFor("invoice.line")).toEqual([invoices.id]);
  });

  it("rejects misplaced or bare wildcards", async () => {
    const hw = ctx.create();
    for (const pattern of ["*.paid", "invoice*", "invoice.*.paid", ".*"]) {
      await expect(
        hw.createEndpoint({
          tenantId: "acme",
          url: receiver.url,
          eventTypes: [pattern],
        }),
      ).rejects.toThrow(/last segment/);
    }
    await expect(
      hw.createEndpoint({
        tenantId: "acme",
        url: receiver.url,
        eventTypes: ["*"],
      }),
    ).rejects.toThrow(/pass null/);
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await expect(
      hw.updateEndpoint(ep.id, { eventTypes: ["a.*.b"] }),
    ).rejects.toThrow(/last segment/);
  });

  it("rejects a wildcard in a sent event type", async () => {
    const hw = ctx.create();
    await expect(
      hw.send({ tenantId: "acme", eventType: "invoice.*", payload: {} }),
    ).rejects.toThrow(/only allowed in an endpoint/);
  });
});

describe("LISTEN/NOTIFY wake-up", () => {
  const channel = () => `${ctx.schema}_wake`;
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Backend pids of Hookgres listener connections for this schema. */
  async function listenerPids(): Promise<number[]> {
    const { rows } = await ctx.pool.query(
      "SELECT pid FROM pg_stat_activity WHERE query = $1",
      [`LISTEN "${channel()}"`],
    );
    return rows.map((r) => r.pid);
  }

  /** A raw connection that records notifications on the channel. */
  async function rawListener() {
    const client = new pg.Client({ connectionString: inject("databaseUrl") });
    await client.connect();
    const received: string[] = [];
    client.on("notification", (n) => received.push(n.channel));
    await client.query(`listen ${channel()}`);
    return { received, end: () => client.end() };
  }

  /** A worker that only wakes on NOTIFY (or after a minute). */
  async function startWorker(
    options: Parameters<typeof ctx.create>[0] = {},
  ): Promise<Hookgres> {
    const worker = ctx.create({
      notify: true,
      pollIntervalMs: 60_000,
      ...options,
    });
    worker.start();
    await waitFor(async () => (await listenerPids()).length === 1);
    // Let the catch-up pass that follows LISTEN finish.
    await sleepMs(200);
    return worker;
  }

  it("delivers a send from another process without waiting for the poll", async () => {
    await startWorker();
    // A separate instance, like a web process: its send() can't wake the
    // worker in-process.
    const sender = ctx.create({ notify: true });
    await sender.createEndpoint({ tenantId: "acme", url: receiver.url });
    await sender.send({ tenantId: "acme", eventType: "e", payload: {} });
    await waitFor(() => receiver.requests.length === 1, 2000);
  });

  it("does not wake other processes when notify is off on the sender", async () => {
    await startWorker();
    const sender = ctx.create();
    await sender.createEndpoint({ tenantId: "acme", url: receiver.url });
    await sender.send({ tenantId: "acme", eventType: "e", payload: {} });
    await sleepMs(500);
    expect(receiver.requests).toHaveLength(0);
  });

  it("notifies on commit only, and never for a rolled-back send", async () => {
    const listener = await rawListener();
    try {
      const hw = ctx.create({ notify: true });
      await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
      const client = await ctx.pool.connect();
      try {
        await client.query("BEGIN");
        await hw.send(
          { tenantId: "acme", eventType: "e", payload: {} },
          { client },
        );
        await client.query("ROLLBACK");
        await sleepMs(200);
        expect(listener.received).toEqual([]);

        await client.query("BEGIN");
        await hw.send(
          { tenantId: "acme", eventType: "e", payload: {} },
          { client },
        );
        await sleepMs(200);
        expect(listener.received).toEqual([]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await waitFor(() => listener.received.length === 1, 2000);
      expect(listener.received).toEqual([channel()]);
    } finally {
      await listener.end();
    }
  });

  it("notifies only when a delivery was queued, and on replay", async () => {
    const listener = await rawListener();
    try {
      const hw = ctx.create({ notify: true });
      await hw.send({ tenantId: "nobody", eventType: "e", payload: {} });
      const plain = ctx.create();
      await plain.createEndpoint({ tenantId: "acme", url: receiver.url });
      const { message } = await plain.send({
        tenantId: "acme",
        eventType: "e",
        payload: {},
      });
      await sleepMs(200);
      expect(listener.received).toEqual([]);

      await drain(plain);
      const [delivery] = await plain.listDeliveries({ messageId: message.id });
      expect(await hw.replayDelivery(delivery?.id ?? "")).toMatchObject({
        status: "pending",
      });
      await waitFor(() => listener.received.length === 1, 2000);
    } finally {
      await listener.end();
    }
  });

  it("releases the listener connection on stop()", async () => {
    const worker = await startWorker();
    const before = ctx.pool.totalCount;
    await worker.stop();
    await waitFor(async () => (await listenerPids()).length === 0);
    expect(ctx.pool.totalCount).toBe(before - 1);
    // start() again listens again.
    worker.start();
    await waitFor(async () => (await listenerPids()).length === 1);
  });

  it("reconnects after the listener connection is killed, and keeps delivering", async () => {
    const errors: unknown[] = [];
    const worker = await startWorker({
      pollIntervalMs: 200,
      onError: (error) => errors.push(error),
    });
    const [pid] = await listenerPids();
    await ctx.pool.query("SELECT pg_terminate_backend($1)", [pid]);

    // Polling still delivers while the listener is down.
    await worker.createEndpoint({ tenantId: "acme", url: receiver.url });
    const sender = ctx.create({ notify: true });
    await sender.send({ tenantId: "acme", eventType: "e", payload: {} });
    await waitFor(() => receiver.requests.length === 1, 2000);

    await waitFor(async () => {
      const pids = await listenerPids();
      return pids.length === 1 && pids[0] !== pid;
    });
    expect(String((errors[0] as Error).message)).toMatch(
      /LISTEN connection lost/,
    );
    await worker.stop();
    await waitFor(async () => (await listenerPids()).length === 0);

    // The new connection wakes a worker with a long poll interval.
    await startWorker();
    await sender.send({ tenantId: "acme", eventType: "e", payload: {} });
    await waitFor(() => receiver.requests.length === 2, 2000);
  });

  it("truncates the channel name to 63 bytes for long schema names", async () => {
    const schema = `s${"x".repeat(62)}`;
    const hw = ctx.create({ schema, notify: true });
    const client = await ctx.pool.connect();
    try {
      await hw.migrate();
      await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
      hw.start();
      await waitFor(async () => {
        const { rows } = await client.query(
          "SELECT 1 FROM pg_stat_activity WHERE query = $1",
          [`LISTEN "${`${schema}_wake`.slice(0, 63)}"`],
        );
        return rows.length === 1;
      });
      await hw.stop();
    } finally {
      client.release();
      await ctx.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
});

describe("delivery hooks", () => {
  function recorder() {
    const attempts: AttemptEvent[] = [];
    const disabled: EndpointDisabledEvent[] = [];
    return {
      attempts,
      disabled,
      onAttempt: (event: AttemptEvent) => {
        attempts.push(event);
      },
      onEndpointDisabled: (event: EndpointDisabledEvent) => {
        disabled.push(event);
      },
    };
  }

  it("reports a successful attempt", async () => {
    const rec = recorder();
    const hw = ctx.create(rec);
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "invoice.paid",
      payload: {},
    });
    await drain(hw);

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(rec.attempts).toEqual([
      {
        deliveryId: delivery?.id,
        messageId: message.id,
        endpointId: ep.id,
        tenantId: "acme",
        eventType: "invoice.paid",
        attemptNumber: 1,
        outcome: "succeeded",
        statusCode: 200,
        error: null,
        durationMs: expect.any(Number),
        nextAttemptAt: null,
      },
    ]);
    expect(rec.disabled).toEqual([]);
  });

  it("reports retrying with the next attempt time, then failed", async () => {
    const rec = recorder();
    const hw = ctx.create({ ...rec, retrySchedule: [0] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 503;
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    await drain(hw);

    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(rec.attempts.map((a) => [a.attemptNumber, a.outcome])).toEqual([
      [1, "retrying"],
      [2, "failed"],
    ]);
    const [first, last] = rec.attempts as [AttemptEvent, AttemptEvent];
    expect(first).toMatchObject({ statusCode: 503, error: "HTTP 503" });
    expect(first.nextAttemptAt).toBeInstanceOf(Date);
    expect(last.nextAttemptAt).toBeNull();
    expect(delivery?.status).toBe("failed");
  });

  it("reports network errors with a null status code", async () => {
    const rec = recorder();
    const hw = ctx.create({ ...rec, retrySchedule: [] });
    await hw.createEndpoint({ tenantId: "acme", url: await closedPortUrl() });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);
    expect(rec.attempts).toHaveLength(1);
    expect(rec.attempts[0]).toMatchObject({
      outcome: "failed",
      statusCode: null,
      error: expect.stringMatching(/ECONNREFUSED/),
    });
  });

  it("reports the attempt that disables an endpoint as failed", async () => {
    const rec = recorder();
    const hw = ctx.create({
      ...rec,
      retrySchedule: [60_000],
      disableEndpointAfterMs: 0,
    });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);

    expect(rec.attempts).toHaveLength(1);
    expect(rec.attempts[0]).toMatchObject({
      outcome: "failed",
      nextAttemptAt: null,
    });
    expect(rec.disabled).toHaveLength(1);
  });

  it("reports an endpoint disabled once when two workers disable it together", async () => {
    const rec = recorder();
    const options = {
      ...rec,
      retrySchedule: [60_000],
      disableEndpointAfterMs: 0,
      concurrency: 1,
    };
    const one = ctx.create(options);
    const two = ctx.create(options);
    const ep = await one.createEndpoint({
      tenantId: "acme",
      url: receiver.url,
    });
    receiver.respond = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 500;
    };
    await one.send({ tenantId: "acme", eventType: "e", payload: {} });
    await one.send({ tenantId: "acme", eventType: "e", payload: {} });
    await Promise.all([one.runOnce(), two.runOnce()]);

    expect(receiver.requests).toHaveLength(2);
    expect(rec.disabled).toEqual([
      expect.objectContaining({ endpointId: ep.id }),
    ]);
  });

  it("reports an endpoint disabled automatically, once", async () => {
    const rec = recorder();
    const hw = ctx.create({
      ...rec,
      retrySchedule: [0],
      disableEndpointAfterMs: 0,
    });
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);

    expect(rec.disabled).toEqual([
      {
        endpointId: ep.id,
        tenantId: "acme",
        reason: expect.stringMatching(/^Disabled automatically/),
      },
    ]);
    expect((await hw.getEndpoint(ep.id))?.disabled).toBe(true);
  });

  it("does not report results discarded from a stale worker", async () => {
    const rec = recorder();
    const hw = ctx.create(rec);
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = async () => {
      // Another worker takes over the claim while this request is in flight.
      await ctx.pool.query(
        `UPDATE "${ctx.schema}".deliveries SET lock_token = gen_random_uuid()`,
      );
      return 200;
    };
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await hw.runOnce();
    expect(receiver.requests).toHaveLength(1);
    expect(rec.attempts).toEqual([]);
  });

  it("keeps delivering when a hook throws or rejects, and emits a warning", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const hw = ctx.create({
        retrySchedule: [],
        disableEndpointAfterMs: 0,
        onAttempt: () => {
          throw new Error("metrics down");
        },
        onEndpointDisabled: async () => {
          throw new Error("pager down");
        },
      });
      const ok = await hw.createEndpoint({ tenantId: "a", url: receiver.url });
      await hw.createEndpoint({ tenantId: "b", url: await closedPortUrl() });
      await hw.send({ tenantId: "a", eventType: "e", payload: {} });
      await hw.send({ tenantId: "b", eventType: "e", payload: {} });
      await drain(hw);

      expect(receiver.requests).toHaveLength(1);
      const [delivery] = await hw.listDeliveries({ endpointId: ok.id });
      expect(delivery?.status).toBe("succeeded");
      await waitFor(() => warn.mock.calls.length === 3);
      const messages = warn.mock.calls.map((c) => String(c[0])).sort();
      expect(messages).toEqual([
        "Hookgres onAttempt hook threw: metrics down",
        "Hookgres onAttempt hook threw: metrics down",
        "Hookgres onEndpointDisabled hook threw: pager down",
      ]);
      for (const call of warn.mock.calls) {
        expect(call[1]).toEqual({ code: "HOOKGRES_HOOK_ERROR" });
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("handles unprintable errors and non-native rejected thenables", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const hw = ctx.create({
        onAttempt: () =>
          ({
            // biome-ignore lint/suspicious/noThenProperty: a custom thenable
            then: (_: unknown, reject: (e: unknown) => void) =>
              reject(Object.create(null)),
          }) as unknown as undefined,
      });
      await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
      await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
      await drain(hw);
      expect(receiver.requests).toHaveLength(1);
      await waitFor(() => warn.mock.calls.length === 1);
      expect(String(warn.mock.calls[0]?.[0])).toBe(
        "Hookgres onAttempt hook threw: unprintable error",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
