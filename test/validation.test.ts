import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import {
  Hookgres,
  type HookgresOptions,
  HookgresValidationError,
  sign,
  WebhookVerificationError,
} from "../src/index.js";
import { useHookgres } from "./helpers.js";

const ctx = useHookgres();

/** Asserts `fn` throws a HookgresValidationError whose message matches. */
async function expectValidation(
  fn: () => unknown,
  message: RegExp,
): Promise<HookgresValidationError> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HookgresValidationError);
  expect(caught).toBeInstanceOf(Error);
  const error = caught as HookgresValidationError;
  expect(error.name).toBe("HookgresValidationError");
  expect(error.message).toMatch(message);
  expect(error.stack).toContain(error.message);
  return error;
}

describe("HookgresValidationError", () => {
  it("is thrown for invalid endpoint input", async () => {
    const hw = ctx.create();
    const base = { tenantId: "acme", url: "https://example.com/webhooks" };
    await expectValidation(
      () => hw.createEndpoint({ ...base, url: "not a url" }),
      /^Invalid endpoint URL: not a url\. Pass an absolute URL/,
    );
    await expectValidation(
      () => hw.createEndpoint({ ...base, url: "ftp://example.com/" }),
      /^Endpoint URL must use http or https: ftp:\/\/example\.com\//,
    );
    await expectValidation(
      () => hw.createEndpoint({ ...base, eventTypes: [] }),
      /^eventTypes must not be empty/,
    );
    await expectValidation(
      () => hw.createEndpoint({ ...base, eventTypes: ["*"] }),
      /^eventTypes must not contain "\*"/,
    );
    await expectValidation(
      () => hw.createEndpoint({ ...base, eventTypes: ["a.*.b"] }),
      /^Invalid event type pattern "a\.\*\.b"/,
    );
    await expectValidation(
      () => hw.createEndpoint({ ...base, secret: "nope" }),
      /^Invalid webhook secret: expected whsec_/,
    );

    const endpoint = await hw.createEndpoint(base);
    await expectValidation(
      () => hw.updateEndpoint(endpoint.id, { url: "nope" }),
      /^Invalid endpoint URL/,
    );
    await expectValidation(
      () => hw.updateEndpoint(endpoint.id, { eventTypes: [] }),
      /^eventTypes must not be empty/,
    );
    await expectValidation(
      () => hw.rotateEndpointSecret(endpoint.id, { secret: "whsec_short" }),
      /^Invalid webhook secret/,
    );
  });

  it("is thrown for private addresses with blockPrivateAddresses", async () => {
    const hw = ctx.create({ blockPrivateAddresses: true });
    await expectValidation(
      () =>
        hw.createEndpoint({ tenantId: "acme", url: "http://127.0.0.1/hook" }),
      /^Endpoint URL points to a private address: http:\/\/127\.0\.0\.1\/hook/,
    );
    await expectValidation(
      () =>
        hw.createEndpoint({
          tenantId: "acme",
          url: "https://example.com:22/hook",
        }),
      /^Endpoint URL uses a blocked port/,
    );
    const endpoint = await hw.createEndpoint({
      tenantId: "acme",
      url: "https://example.com/hook",
    });
    await expectValidation(
      () => hw.updateEndpoint(endpoint.id, { url: "http://localhost/hook" }),
      /^Endpoint URL points to a private address/,
    );
  });

  it("is thrown for invalid send() input", async () => {
    const hw = ctx.create();
    await expectValidation(
      () => hw.send({ tenantId: "acme", eventType: "invoice.*", payload: {} }),
      /^Invalid event type "invoice\.\*"/,
    );
    await expectValidation(
      () => hw.send({ tenantId: "acme", eventType: "a.b", payload: undefined }),
      /^send\(\) requires a JSON-serialisable payload/,
    );
    const error = await expectValidation(
      () =>
        hw.send({ tenantId: "acme", eventType: "a.b", payload: "x\u0000y" }),
      /^Payload contains a NUL character/,
    );
    // The database error stays available as the cause.
    expect((error.cause as { code?: string }).code).toBe("22P05");
  });

  it("is thrown for invalid options and cleanup() arguments", async () => {
    const pool = ctx.pool;
    await expectValidation(
      () => new Hookgres({}),
      /^new Hookgres\(\) needs either `pool`/,
    );
    await expectValidation(
      () => new Hookgres({ pool, schema: "Bad-Name" }),
      /^Invalid schema name "Bad-Name"/,
    );
    await expectValidation(
      () => new Hookgres({ pool, retrySchedule: [-1] }),
      /^retrySchedule must contain non-negative numbers/,
    );
    await expectValidation(
      () => new Hookgres({ pool, retryJitter: 2 }),
      /^retryJitter must be a number between 0 and 1/,
    );
    await expectValidation(
      () => new Hookgres({ pool, requestTimeoutMs: 5000, lockTimeoutMs: 1000 }),
      /^lockTimeoutMs \(1000\) must be greater than requestTimeoutMs \(5000\)/,
    );
    await expectValidation(
      () =>
        new Hookgres({
          pool: new pg.Pool({
            connectionString: inject("databaseUrl"),
            max: 1,
          }),
          notify: true,
        }),
      /^notify needs a pool with max of at least 2/,
    );
    await expectValidation(
      () =>
        new Hookgres({
          pool,
          blockPrivateAddresses: { allow: "10.0.0.0/8" as unknown as string[] },
        }),
      /^blockPrivateAddresses\.allow must be an array/,
    );
    await expectValidation(
      () => new Hookgres({ pool, blockPrivateAddresses: { allow: ["nope"] } }),
      /^Invalid blockPrivateAddresses\.allow entry "nope"/,
    );

    const hw = ctx.create();
    await expectValidation(
      () => hw.cleanup({ olderThan: 0, batchSize: 0 }),
      /^cleanup batchSize must be a positive integer/,
    );
    await expectValidation(
      () => hw.cleanup({ olderThan: new Date("nope") }),
      /^cleanup olderThan is an invalid Date/,
    );
    await expectValidation(
      () => hw.cleanup({ olderThan: -1 }),
      /^cleanup olderThan must be a Date or a non-negative number/,
    );
  });

  it("is thrown for numeric options that would break the worker", async () => {
    const pool = ctx.pool;
    for (const [options, message] of [
      [{ concurrency: Number.NaN }, /^concurrency must be a positive integer/],
      [{ concurrency: 2.5 }, /^concurrency must be a positive integer/],
      [{ concurrency: 0 }, /^concurrency must be a positive integer/],
      [{ lockTimeoutMs: Number.NaN }, /^lockTimeoutMs must be a number/],
      [{ lockTimeoutMs: Number.POSITIVE_INFINITY }, /^lockTimeoutMs must be/],
      [{ requestTimeoutMs: Number.NaN }, /^requestTimeoutMs must be/],
      [{ requestTimeoutMs: 0 }, /^requestTimeoutMs must be/],
      [{ pollIntervalMs: 0 }, /^pollIntervalMs must be/],
      [{ pollIntervalMs: 2 ** 31 }, /^pollIntervalMs must be/],
      [
        { disableEndpointAfterMs: Number.NaN },
        /^disableEndpointAfterMs must be/,
      ],
      [
        { disableEndpointAfterMs: Number.POSITIVE_INFINITY },
        /or null to never disable/,
      ],
      [
        { retrySchedule: [1e17] },
        /^retrySchedule must contain non-negative numbers/,
      ],
      [
        { secretRotationGraceMs: Number.POSITIVE_INFINITY },
        /^secretRotationGraceMs/,
      ],
    ] as Array<[Partial<HookgresOptions>, RegExp]>) {
      await expectValidation(() => new Hookgres({ pool, ...options }), message);
    }
    // Numeric strings (from process.env) keep working, as they did through
    // implicit coercion, and so do large concurrency values.
    const fromEnv = new Hookgres({
      pool,
      concurrency: "25" as unknown as number,
      pollIntervalMs: "500" as unknown as number,
    });
    expect(() => new Hookgres({ pool, concurrency: 5000 })).not.toThrow();
    const clamped = new Hookgres({ pool, schema: ctx.schema });
    expect(
      (await clamped.listDeliveries({ limit: 0 })).length,
    ).toBeLessThanOrEqual(1); // clamped to 1, as before
    void fromEnv;
    // null still means "never disable".
    expect(
      () => new Hookgres({ pool, disableEndpointAfterMs: null }),
    ).not.toThrow();
  });

  it("is thrown for arguments that would reach SQL as nonsense", async () => {
    const hw = ctx.create();
    const endpoint = await hw.createEndpoint({
      tenantId: "acme",
      url: "https://example.com/hook",
    });
    await expectValidation(
      () => hw.listDeliveries({ limit: Number.NaN }),
      /^listDeliveries limit must be a number/,
    );
    await expectValidation(
      () =>
        hw.rotateEndpointSecret(endpoint.id, {
          graceMs: Number.POSITIVE_INFINITY,
        }),
      /^graceMs must be a number/,
    );
    await expectValidation(
      () => hw.cleanup({ olderThan: 1e20 }),
      /^cleanup olderThan must be/,
    );
  });

  it("is thrown for endpoint input that could never deliver", async () => {
    const hw = ctx.create();
    const base = { tenantId: "acme", url: "https://example.com/webhooks" };
    const error = await expectValidation(
      () =>
        hw.createEndpoint({
          ...base,
          url: "https://admin:hunter2@example.com/",
        }),
      /^Endpoint URL must not contain credentials/,
    );
    expect(error.message).not.toContain("hunter2");
    await expectValidation(
      () =>
        hw.createEndpoint({
          ...base,
          eventTypes: "invoice.paid" as unknown as string[],
        }),
      /^eventTypes must be an array of strings/,
    );
    const endpoint = await hw.createEndpoint(base);
    await expectValidation(
      () => hw.updateEndpoint(endpoint.id, { url: "https://u:p@example.com/" }),
      /^Endpoint URL must not contain credentials/,
    );
  });

  it("is thrown for payloads and keys Postgres can't store", async () => {
    const hw = ctx.create();
    const send = (payload: unknown, idempotencyKey?: string) =>
      hw.send({ tenantId: "acme", eventType: "a.b", payload, idempotencyKey });
    await expectValidation(
      () => send({ text: "cut emoji \ud83d" }),
      /unpaired UTF-16 surrogate/,
    );
    await expectValidation(() => send({ "\udc00": 1 }), /unpaired UTF-16/);
    await expectValidation(
      () => send(() => 1),
      /must be JSON-serialisable, got a function/,
    );
    await expectValidation(
      () => send(Symbol("x")),
      /must be JSON-serialisable/,
    );
    await expectValidation(
      () => send({ toJSON: () => undefined }),
      /must be JSON-serialisable/,
    );
    await expectValidation(
      () => send({ tags: new Set(["a"]) }),
      /contains a Set/,
    );
    await expectValidation(() => send({ index: new Map() }), /contains a Map/);
    await expectValidation(() => send({ n: 10n }), /BigInt/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expectValidation(() => send(circular), /JSON-serialisable/);
    await expectValidation(
      () => send({}, "k".repeat(2001)),
      /^idempotencyKey is longer than 2000 bytes/,
    );
    // Whole emoji, and keys at the limit, are fine.
    await expect(
      send({ text: "ok 😀" }, "k".repeat(2000)),
    ).resolves.toBeTruthy();
  });

  it("is thrown by verifyWebhook for a tolerance that would disable the replay check", async () => {
    const { verifyWebhook } = await import("../src/index.js");
    const secret = `whsec_${Buffer.from("k".repeat(32)).toString("base64")}`;
    const timestamp = Math.floor(Date.now() / 1000) - 10 * 365 * 24 * 3600;
    const body = "{}";
    const headers = {
      "webhook-id": "msg_1",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": sign(secret, "msg_1", timestamp, body),
    };
    expect(() =>
      verifyWebhook({ secret, headers, body, toleranceSeconds: Number.NaN }),
    ).toThrow(TypeError);
    expect(() =>
      verifyWebhook({ secret, headers, body, toleranceSeconds: -1 }),
    ).toThrow(TypeError);
    // Infinity turns the check off on purpose; numeric strings are accepted.
    expect(
      verifyWebhook({
        secret,
        headers,
        body,
        toleranceSeconds: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({});
    expect(() =>
      verifyWebhook({
        secret,
        headers,
        body,
        toleranceSeconds: "300" as unknown as number,
      }),
    ).toThrow(/outside tolerance/);
  });

  it("is thrown by sign() for an empty secret", async () => {
    await expectValidation(
      () => sign("whsec_", "msg_1", 1, "{}"),
      /^Invalid webhook secret: expected the endpoint's whsec_ secret/,
    );
  });

  it("is not used for database or verification errors", async () => {
    const missing = new Hookgres({ pool: ctx.pool, schema: "hw_missing" });
    const dbError = await missing.listEndpoints("acme").catch((e) => e);
    expect(dbError).toMatchObject({ code: "42P01" });
    expect(dbError).not.toBeInstanceOf(HookgresValidationError);

    const { verifyWebhook } = await import("../src/index.js");
    let verifyError: unknown;
    try {
      verifyWebhook({ secret: "whsec_", headers: {}, body: "{}" });
    } catch (error) {
      verifyError = error;
    }
    expect(verifyError).toBeInstanceOf(WebhookVerificationError);
    expect(verifyError).not.toBeInstanceOf(HookgresValidationError);
  });
});
