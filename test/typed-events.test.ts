import * as v from "valibot";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as z from "zod";
import * as z3 from "zod/v3";
import {
  type EventTypeFilter,
  Hookgres,
  HookgresValidationError,
  type InferEvents,
  type SendInput,
  type StandardSchemaV1,
  verifyWebhook,
  type WebhookEvent,
} from "../src/index.js";
import { drain, startReceiver, useHookgres } from "./helpers.js";

const ctx = useHookgres();

type Events = {
  "invoice.paid": { id: string; amount: number };
  "invoice.voided": { id: string };
  "customer.created": { email: string };
};

const schemas = {
  "invoice.paid": z.object({ id: z.string(), amount: z.number() }),
  "invoice.voided": z.object({ id: z.string() }),
  "customer.created": z.object({ email: z.email() }),
};

// Compile-time checks: `pnpm typecheck` fails if any @ts-expect-error line
// compiles. The function is never called.
async function typeChecks(hookgres: Hookgres<Events>, untyped: Hookgres) {
  // Untyped (the default) accepts any event type and payload, as before 0.6.
  await untyped.send({ tenantId: "a", eventType: "anything", payload: 42 });
  await untyped.createEndpoint({
    tenantId: "a",
    url: "https://e.com",
    eventTypes: ["x.*"],
  });

  // A type-only event map.
  await hookgres.send({
    tenantId: "a",
    eventType: "invoice.paid",
    payload: { id: "in_1", amount: 4200 },
  });
  await hookgres.send({
    tenantId: "a",
    // @ts-expect-error unknown event type
    eventType: "invoice.piad",
    payload: { id: "in_1", amount: 4200 },
  });
  // @ts-expect-error amount is missing
  await hookgres.send({
    tenantId: "a",
    eventType: "invoice.paid",
    payload: { id: "in_1" },
  });
  await hookgres.send({
    tenantId: "a",
    eventType: "customer.created",
    // @ts-expect-error a payload of another event type
    payload: { id: "in_1" },
  });

  // Endpoint filters suggest known types and wildcards, but accept strings
  // from your customers (checked at runtime when you use schemas).
  expectTypeOf<"invoice.*">().toExtend<EventTypeFilter<Events>>();
  expectTypeOf<"customer.created">().toExtend<EventTypeFilter<Events>>();
  const fromRequest: string[] = ["invoice.paid"];
  await hookgres.createEndpoint({
    tenantId: "a",
    url: "https://e.com",
    eventTypes: fromRequest,
  });
  await hookgres.updateEndpoint("ep_1", { eventTypes: ["invoice.*"] });

  // Inferred from Zod 4 schemas.
  const zod = new Hookgres({ connectionString: "postgres://x", schemas });
  expectTypeOf(zod).toEqualTypeOf<Hookgres<Events>>();
  await zod.send({
    tenantId: "a",
    eventType: "customer.created",
    payload: { email: "a@b.co" },
  });
  await zod.send({
    tenantId: "a",
    eventType: "customer.created",
    // @ts-expect-error email must be a string
    payload: { email: 1 },
  });

  // Inferred from Zod 3 and Valibot schemas.
  const zod3 = new Hookgres({
    connectionString: "postgres://x",
    schemas: { "user.deleted": z3.object({ userId: z3.string() }) },
  });
  await zod3.send({
    tenantId: "a",
    eventType: "user.deleted",
    payload: { userId: "u_1" },
  });
  // @ts-expect-error userId is missing
  await zod3.send({ tenantId: "a", eventType: "user.deleted", payload: {} });
  const valibot = new Hookgres({
    connectionString: "postgres://x",
    schemas: { "order.shipped": v.object({ orderId: v.string() }) },
  });
  await valibot.send({
    tenantId: "a",
    eventType: "order.shipped",
    payload: { orderId: "o_1" },
  });
  await valibot.send({
    tenantId: "a",
    // @ts-expect-error not in the Valibot schemas
    eventType: "order.created",
    payload: { orderId: "o_1" },
  });

  // send() takes the schema's input; receivers get its output.
  const transforming = {
    "invoice.paid": z.object({ amount: z.string().transform(Number) }),
  };
  const t = new Hookgres({
    connectionString: "postgres://x",
    schemas: transforming,
  });
  await t.send({
    tenantId: "a",
    eventType: "invoice.paid",
    payload: { amount: "42" },
  });
  expectTypeOf<InferEvents<typeof transforming>>().toEqualTypeOf<{
    "invoice.paid": { amount: number };
  }>();

  // Receivers narrow the verified event on its type.
  const event = verifyWebhook<WebhookEvent<Events>>({
    secret: "whsec_x",
    headers: {},
    body: "",
  });
  if (event.type === "invoice.paid") {
    expectTypeOf(event.data).toEqualTypeOf<{ id: string; amount: number }>();
  }

  // Event maps can be interfaces, not only type aliases.
  interface EventsInterface {
    "invoice.paid": { id: string };
  }
  const fromInterface = new Hookgres<EventsInterface>({
    connectionString: "postgres://x",
  });
  await fromInterface.send({
    tenantId: "a",
    eventType: "invoice.paid",
    payload: { id: "in_1" },
  });
  await fromInterface.send({
    tenantId: "a",
    eventType: "invoice.paid",
    // @ts-expect-error id must be a string
    payload: { id: 1 },
  });
  expectTypeOf<
    WebhookEvent<EventsInterface>["type"]
  >().toEqualTypeOf<"invoice.paid">();

  // The default SendInput is the pre-0.6 shape.
  expectTypeOf<SendInput>().toEqualTypeOf<{
    tenantId: string;
    eventType: string;
    payload: unknown;
    idempotencyKey?: string;
  }>();
}
void typeChecks;

async function messageCount(): Promise<number> {
  const { rows } = await ctx.pool.query(
    `SELECT count(*)::int AS n FROM "${ctx.schema}".messages`,
  );
  return rows[0].n;
}

async function rejects(
  fn: () => Promise<unknown>,
  message: RegExp,
): Promise<HookgresValidationError> {
  const error = await fn().then(
    () => {
      throw new Error("expected a HookgresValidationError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HookgresValidationError);
  expect((error as Error).message).toMatch(message);
  return error as HookgresValidationError;
}

describe("schemas", () => {
  it("stores and delivers the schema's output", async () => {
    const receiver = await startReceiver();
    try {
      const hw = ctx.create({
        schemas: {
          "invoice.paid": z.object({
            id: z.string(),
            amount: z.string().transform(Number),
          }),
        },
      });
      await hw.createEndpoint({
        tenantId: "acme",
        url: receiver.url,
        eventTypes: ["invoice.*"],
      });
      const { message, deliveryCount } = await hw.send({
        tenantId: "acme",
        eventType: "invoice.paid",
        payload: { id: "in_1", amount: "4200", internalNote: "drop me" },
      });
      expect(deliveryCount).toBe(1);
      // Zod strips unknown keys and applies the transform.
      expect(message.payload).toEqual({ id: "in_1", amount: 4200 });
      expect((await hw.getMessage(message.id))?.payload).toEqual({
        id: "in_1",
        amount: 4200,
      });
      await drain(hw);
      expect(JSON.parse(receiver.requests[0]?.body ?? "{}").data).toEqual({
        id: "in_1",
        amount: 4200,
      });
    } finally {
      await receiver.close();
    }
  });

  it("rejects an invalid payload with its issues and queues nothing", async () => {
    const hw = ctx.create({ schemas });
    const error = await rejects(
      () =>
        hw.send({
          tenantId: "acme",
          eventType: "invoice.paid",
          payload: { id: 1 },
        }),
      /^Invalid payload for "invoice\.paid": payload\.id, payload\.amount failed the schema \(see `issues`\)\. Nothing was queued\./,
    );
    expect(error.issues?.map((issue) => issue.path)).toEqual([
      ["id"],
      ["amount"],
    ]);
    expect(await messageCount()).toBe(0);
  });

  it("never puts payload values in the message", async () => {
    const hw = ctx.create({
      schemas: {
        "user.created": v.object({ email: v.pipe(v.string(), v.email()) }),
      },
    });
    const error = await rejects(
      () =>
        hw.send({
          tenantId: "acme",
          eventType: "user.created",
          payload: { email: "secret-value@" },
        }),
      /^Invalid payload for "user\.created": payload\.email failed/,
    );
    expect(error.message).not.toContain("secret-value");
    // Valibot quotes the value; it's only in `issues`.
    expect(JSON.stringify(error.issues)).toContain("secret-value");
  });

  it("wraps a schema that throws", async () => {
    const boom = new Error("transform failed");
    const hw = ctx.create({
      schemas: {
        "invoice.paid": z.object({ raw: z.string() }).transform(() => {
          throw boom;
        }),
      },
    });
    const error = await rejects(
      () =>
        hw.send({
          tenantId: "acme",
          eventType: "invoice.paid",
          payload: { raw: "x" },
        }),
      /^The schema for "invoice\.paid" threw while validating the payload/,
    );
    expect(error.cause).toBe(boom);
    expect(error.issues).toBeUndefined();
    expect(await messageCount()).toBe(0);
  });

  it("rejects an event type that has no schema", async () => {
    const hw = ctx.create({ schemas });
    await rejects(
      () =>
        hw.send({ tenantId: "acme", eventType: "invoice.piad", payload: {} }),
      /^No schema for event type "invoice\.piad": add it to `schemas`.*Nothing was queued\./,
    );
    expect(await messageCount()).toBe(0);
  });

  it("validates inside the caller's transaction, before writing", async () => {
    const hw = ctx.create({ schemas });
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await rejects(
        () =>
          hw.send(
            { tenantId: "acme", eventType: "invoice.voided", payload: {} },
            { client },
          ),
        /^Invalid payload for "invoice\.voided"/,
      );
      // The transaction is still usable: validation ran no SQL.
      await client.query("SELECT 1");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await messageCount()).toBe(0);
  });

  it("supports async schemas and validates once with redactPayloads", async () => {
    // A hand-written async Standard Schema, to count validate() calls.
    let runs = 0;
    const userDeleted: StandardSchemaV1<{ userId: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value) => {
          runs++;
          return { value: value as { userId: string } };
        },
      },
    };
    const hw = ctx.create({
      redactPayloads: true,
      schemas: { "user.deleted": userDeleted },
    });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "user.deleted",
      payload: { userId: "u_1" },
    });
    expect(runs).toBe(1);
    // No endpoint matched, so redactPayloads cleared it right away.
    expect(message.payload).toBeNull();
  });

  it("works with Valibot and Zod 3 schemas", async () => {
    const hw = ctx.create({
      schemas: {
        "order.shipped": v.object({ orderId: v.string() }),
        "user.deleted": z3.object({ userId: z3.string() }),
      },
    });
    await hw.send({
      tenantId: "acme",
      eventType: "order.shipped",
      payload: { orderId: "o_1" },
    });
    await rejects(
      () =>
        hw.send({ tenantId: "acme", eventType: "user.deleted", payload: {} }),
      /^Invalid payload for "user\.deleted": payload\.userId failed/,
    );
    await rejects(
      () =>
        hw.send({ tenantId: "acme", eventType: "order.shipped", payload: {} }),
      /^Invalid payload for "order\.shipped": payload\.orderId failed/,
    );
    expect(await messageCount()).toBe(1);
  });

  it("rejects endpoint event types that match no schema", async () => {
    const hw = ctx.create({ schemas });
    const base = { tenantId: "acme", url: "https://example.com/webhooks" };
    await rejects(
      () => hw.createEndpoint({ ...base, eventTypes: ["invoice.piad"] }),
      /^Unknown event type "invoice\.piad" in eventTypes: it matches no event type this app sends\. See /,
    );
    await rejects(
      () => hw.createEndpoint({ ...base, eventTypes: ["order.*"] }),
      /^Unknown event type "order\.\*"/,
    );
    const endpoint = await hw.createEndpoint({
      ...base,
      eventTypes: ["invoice.*", "customer.created"],
    });
    await hw.createEndpoint({ ...base, eventTypes: null });
    await rejects(
      () => hw.updateEndpoint(endpoint.id, { eventTypes: ["nope"] }),
      /^Unknown event type "nope"/,
    );
    expect(
      (await hw.updateEndpoint(endpoint.id, { eventTypes: ["invoice.voided"] }))
        ?.eventTypes,
    ).toEqual(["invoice.voided"]);
  });

  it("rejects schemas that aren't Standard Schemas or use wildcards", () => {
    const base = { connectionString: "postgres://localhost/x" };
    expect(
      () => new Hookgres({ ...base, schemas: { "a.b": {} as never } }),
    ).toThrow(/^schemas\["a\.b"\] is not a Standard Schema/);
    expect(
      () => new Hookgres({ ...base, schemas: { "a.*": z.object({}) } }),
    ).toThrow(/^Invalid event type "a\.\*" in schemas/);
  });

  it("changes nothing without schemas", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({
      tenantId: "acme",
      url: "https://example.com/webhooks",
      eventTypes: ["anything.*"],
    });
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "whatever",
      payload: { extra: true },
    });
    expect(message.payload).toEqual({ extra: true });
  });
});
