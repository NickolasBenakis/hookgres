import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import {
  Hookgres,
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
