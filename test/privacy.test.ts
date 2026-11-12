import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookgresValidationError } from "../src/index.js";
import { drain, type Receiver, startReceiver, useHookgres } from "./helpers.js";

const ctx = useHookgres();
let receiver: Receiver;

beforeEach(async () => {
  receiver = await startReceiver();
});
afterEach(async () => {
  await receiver.close();
});

async function rawPayload(id: string): Promise<unknown> {
  const { rows } = await ctx.pool.query(
    `SELECT payload FROM "${ctx.schema}".messages WHERE id = $1`,
    [id],
  );
  return rows[0]?.payload;
}

describe("redactPayloads", () => {
  it("clears the payload once every delivery succeeded, keeping the log", async () => {
    const hw = ctx.create({ redactPayloads: true });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "user.updated",
      payload: { email: "anna@example.com" },
    });
    expect(message.redactedAt).toBeNull();

    await drain(hw);

    // Both receivers got the real payload.
    expect(receiver.requests).toHaveLength(2);
    for (const request of receiver.requests) {
      expect(JSON.parse(request.body).data).toEqual({
        email: "anna@example.com",
      });
    }
    const stored = await hw.getMessage(message.id);
    expect(stored?.payload).toBeNull();
    expect(stored?.redactedAt).toBeInstanceOf(Date);
    expect(await rawPayload(message.id)).toBeNull();
    const deliveries = await hw.listDeliveries({ messageId: message.id });
    expect(deliveries.map((d) => d.status)).toEqual(["succeeded", "succeeded"]);
    const [attempt] = await hw.listAttempts(deliveries[0]?.id as string);
    expect(attempt?.statusCode).toBe(200);
  });

  it("keeps the payload while a delivery is failing, and redacts after a successful replay", async () => {
    const hw = ctx.create({ redactPayloads: true, retrySchedule: [] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = () => 500;
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: { id: 1 },
    });
    await drain(hw);

    const [failed] = await hw.listDeliveries({ messageId: message.id });
    expect(failed?.status).toBe("failed");
    expect(await rawPayload(message.id)).toEqual({ id: 1 });

    receiver.respond = () => 200;
    await hw.replayDelivery(failed?.id as string);
    await drain(hw);

    expect(JSON.parse(receiver.requests[1]?.body ?? "").data).toEqual({
      id: 1,
    });
    expect((await hw.getMessage(message.id))?.redactedAt).toBeInstanceOf(Date);
  });

  it("waits for the last of several deliveries", async () => {
    const hw = ctx.create({ redactPayloads: true, retrySchedule: [] });
    const ok = await startReceiver();
    try {
      await hw.createEndpoint({ tenantId: "acme", url: ok.url });
      await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
      receiver.respond = () => 500;
      const { message } = await hw.send({
        tenantId: "acme",
        eventType: "e",
        payload: { id: 2 },
      });
      await drain(hw);
      // One succeeded, one failed: the payload stays for replay.
      expect(await rawPayload(message.id)).toEqual({ id: 2 });
    } finally {
      await ok.close();
    }
  });

  it("redacts right away when no endpoint matched", async () => {
    const hw = ctx.create({ redactPayloads: true });
    const { message, deliveryCount } = await hw.send({
      tenantId: "nobody",
      eventType: "e",
      payload: { secret: true },
    });
    expect(deliveryCount).toBe(0);
    expect(message.payload).toBeNull();
    expect(message.redactedAt).toBeInstanceOf(Date);
    expect(await rawPayload(message.id)).toBeNull();
  });

  it("redacts inside the caller's transaction, and not at all on rollback", async () => {
    const hw = ctx.create({ redactPayloads: true });
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      const { message } = await hw.send(
        { tenantId: "nobody", eventType: "e", payload: { a: 1 } },
        { client },
      );
      expect(message.redactedAt).toBeInstanceOf(Date);
      await client.query("ROLLBACK");
      expect(await hw.getMessage(message.id)).toBeNull();
    } finally {
      client.release();
    }
  });

  it("returns the redacted message for a repeated idempotency key", async () => {
    const hw = ctx.create({ redactPayloads: true });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const input = {
      tenantId: "acme",
      eventType: "e",
      payload: { a: 1 },
      idempotencyKey: "k",
    };
    await hw.send(input);
    await drain(hw);
    const again = await hw.send(input);
    expect(again.deduplicated).toBe(true);
    expect(again.message.payload).toBeNull();
    expect(again.message.redactedAt).toBeInstanceOf(Date);
    expect(receiver.requests).toHaveLength(1);
  });

  it("refuses to replay a redacted delivery", async () => {
    const hw = ctx.create({ redactPayloads: true });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    await drain(hw);
    const [delivery] = await hw.listDeliveries({ messageId: message.id });

    const replay = hw.replayDelivery(delivery?.id as string);
    await expect(replay).rejects.toBeInstanceOf(HookgresValidationError);
    await expect(hw.replayDelivery(delivery?.id as string)).rejects.toThrow(
      /redacted/,
    );
    expect(await hw.replayDelivery("dlv_missing")).toBeNull();
  });

  it("fails a claimed delivery whose payload was redacted without sending it", async () => {
    // Only reachable when a replay races a redaction; simulate the outcome.
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: {},
    });
    await ctx.pool.query(
      `UPDATE "${ctx.schema}".messages SET payload = NULL, redacted_at = now() WHERE id = $1`,
      [message.id],
    );
    await drain(hw);
    expect(receiver.requests).toHaveLength(0);
    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    expect(delivery).toMatchObject({
      status: "failed",
      lastError: "Payload was redacted",
      attemptCount: 0,
    });
  });

  it("is off by default", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "e",
      payload: { a: 1 },
    });
    await drain(hw);
    expect(await hw.getMessage(message.id)).toMatchObject({
      payload: { a: 1 },
      redactedAt: null,
    });
  });
});

describe("upgrading without migrate()", () => {
  it("says to run migrate() when a column is missing", async () => {
    const schema = `${ctx.schema}_stale`;
    try {
      const hw = ctx.create({ schema });
      await hw.migrate();
      await ctx.pool.query(
        `ALTER TABLE "${schema}".messages DROP COLUMN redacted_at`,
      );
      await expect(hw.runOnce()).rejects.toThrow(
        /redacted_at.*migrate\(\)` after upgrading/,
      );
    } finally {
      await ctx.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
});

describe("responseBodyLimit", () => {
  it("stores no response bodies at 0", async () => {
    const hw = ctx.create({ responseBodyLimit: 0 });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.body = "personal data";
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);
    const [delivery] = await hw.listDeliveries();
    expect(delivery?.status).toBe("succeeded");
    const [attempt] = await hw.listAttempts(delivery?.id as string);
    expect(attempt).toMatchObject({ statusCode: 200, responseBody: null });
  });

  it("shortens response bodies to the limit", async () => {
    const hw = ctx.create({ responseBodyLimit: 5, retrySchedule: [] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.body = "0123456789";
    receiver.respond = () => 500;
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);
    const [delivery] = await hw.listDeliveries();
    const [attempt] = await hw.listAttempts(delivery?.id as string);
    expect(attempt).toMatchObject({ statusCode: 500, responseBody: "01234" });
  });

  it("defaults to 4096 characters", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.body = "x".repeat(5000);
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await drain(hw);
    const [delivery] = await hw.listDeliveries();
    const [attempt] = await hw.listAttempts(delivery?.id as string);
    expect(attempt?.responseBody).toHaveLength(4096);
  });

  it("validates the option", () => {
    for (const responseBodyLimit of [-1, 1.5, 4097, Number.NaN]) {
      expect(() => ctx.create({ responseBodyLimit })).toThrow(
        HookgresValidationError,
      );
    }
  });
});

describe("deleteMessages", () => {
  async function seed() {
    const hw = ctx.create({ retrySchedule: [] });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.createEndpoint({ tenantId: "globex", url: receiver.url });
    const send = async (tenantId: string, payload: unknown) =>
      (await hw.send({ tenantId, eventType: "e", payload })).message.id;
    const ids = {
      anna1: await send("acme", { userId: "usr_anna", n: 1 }),
      anna2: await send("acme", { userId: "usr_anna", n: 2 }),
      bob: await send("acme", { userId: "usr_bob" }),
      globexAnna: await send("globex", { userId: "usr_anna" }),
    };
    return { hw, ids };
  }

  async function remaining(): Promise<string[]> {
    const { rows } = await ctx.pool.query(
      `SELECT id FROM "${ctx.schema}".messages ORDER BY id`,
    );
    return rows.map((r) => r.id);
  }

  it("deletes a person's messages for one tenant, with their deliveries", async () => {
    const { hw, ids } = await seed();
    await drain(hw);
    const [delivery] = await hw.listDeliveries({ messageId: ids.anna1 });

    const deleted = await hw.deleteMessages({
      tenantId: "acme",
      payloadContains: { userId: "usr_anna" },
      batchSize: 1,
    });

    expect(deleted).toBe(2);
    expect(await remaining()).toEqual([ids.bob, ids.globexAnna].sort());
    expect(await hw.getDelivery(delivery?.id as string)).toBeNull();
    expect(await hw.listAttempts(delivery?.id as string)).toEqual([]);
  });

  it("deletes across tenants when only payloadContains is given", async () => {
    const { hw, ids } = await seed();
    expect(
      await hw.deleteMessages({ payloadContains: { userId: "usr_anna" } }),
    ).toBe(3);
    expect(await remaining()).toEqual([ids.bob]);
  });

  it("deletes all of a tenant's messages, pending ones included, so they're never sent", async () => {
    const { hw, ids } = await seed();
    expect(await hw.deleteMessages({ tenantId: "acme" })).toBe(3);
    await drain(hw);
    expect(await remaining()).toEqual([ids.globexAnna]);
    expect(receiver.requests).toHaveLength(1);
    // Endpoints stay.
    expect(await hw.listEndpoints("acme")).toHaveLength(1);
  });

  it("deletes by message id", async () => {
    const { hw, ids } = await seed();
    expect(
      await hw.deleteMessages({ messageIds: [ids.bob, "msg_missing"] }),
    ).toBe(1);
    expect(await hw.deleteMessages({ messageIds: [] })).toBe(0);
    expect(await remaining()).toHaveLength(3);
  });

  it("keeps going when another transaction deletes the rows a batch picked", async () => {
    const { hw, ids } = await seed();
    const other = await ctx.pool.connect();
    try {
      await other.query("BEGIN");
      // Locks anna1, the row the first one-row batch would pick.
      await other.query(`DELETE FROM "${ctx.schema}".messages WHERE id = $1`, [
        ids.anna1,
      ]);
      const deleting = hw.deleteMessages({
        tenantId: "acme",
        payloadContains: { userId: "usr_anna" },
        batchSize: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await other.query("COMMIT");
      expect(await deleting).toBe(1);
    } finally {
      other.release();
    }
    expect(await remaining()).toEqual([ids.bob, ids.globexAnna].sort());
  });

  it("frees the idempotency key", async () => {
    const hw = ctx.create();
    const input = { tenantId: "acme", eventType: "e", payload: {} };
    await hw.send({ ...input, idempotencyKey: "k" });
    await hw.deleteMessages({ tenantId: "acme" });
    const again = await hw.send({ ...input, idempotencyKey: "k" });
    expect(again.deduplicated).toBe(false);
  });

  it("refuses to run without a filter, and validates its options", async () => {
    const hw = ctx.create();
    await hw.send({ tenantId: "acme", eventType: "e", payload: {} });
    await expect(hw.deleteMessages({})).rejects.toThrow(/at least one filter/);
    await expect(
      hw.deleteMessages({ tenantId: "acme", batchSize: 0 }),
    ).rejects.toThrow(/batchSize/);
    await expect(
      hw.deleteMessages({
        payloadContains: "usr_anna" as unknown as Record<string, unknown>,
      }),
    ).rejects.toBeInstanceOf(HookgresValidationError);
    await expect(
      hw.deleteMessages({
        payloadContains: null as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/payloadContains/);
    // Filters that would match every payload, or widen once stringified.
    for (const payloadContains of [
      {},
      [],
      { userId: undefined },
      { user: { id: undefined } },
      { user: {} },
      { userId: () => "usr_anna" },
      { userId: Number.NaN },
      { userId: Number.POSITIVE_INFINITY },
      { userId: Symbol("x") },
      { userId: 1n },
      { at: new Date() },
      { userId: { toJSON: () => undefined } },
      { toJSON: () => ({}) },
      [undefined],
      new Map([["userId", "usr_anna"]]),
    ] as Record<string, unknown>[]) {
      await expect(hw.deleteMessages({ payloadContains })).rejects.toThrow(
        /non-empty/,
      );
    }
    await expect(
      hw.deleteMessages({ tenantId: 1 as unknown as string }),
    ).rejects.toThrow(/tenantId/);
    await expect(
      hw.deleteMessages({ messageIds: [1] as unknown as string[] }),
    ).rejects.toThrow(/messageIds/);
    expect(await remaining()).toHaveLength(1);
  });
});
