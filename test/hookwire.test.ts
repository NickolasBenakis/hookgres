import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyWebhook, type WebhookEnvelope } from "../src/index.js";
import {
  drain,
  type Receiver,
  startReceiver,
  useHookwire,
  waitFor,
} from "./helpers.js";

const ctx = useHookwire();
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
    expect(rows[0].n).toBe(1);
  });

  it("rejects unsafe schema names", () => {
    expect(() => ctx.create({ schema: 'x"; DROP TABLE y; --' })).toThrow(
      /Invalid schema name/,
    );
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
      url: "http://127.0.0.1:1/",
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
    expect(errors.some((e) => /ECONNREFUSED|fetch failed/.test(e))).toBe(true);
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
    });
    expect(receiver.requests).toHaveLength(0);
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
