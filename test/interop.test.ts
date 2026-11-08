import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSecret, sign, verifyWebhook } from "../src/index.js";
import { drain, type Receiver, startReceiver, useHookgres } from "./helpers.js";

/**
 * Cross-checks Hookgres against the official Standard Webhooks library
 * (https://github.com/standard-webhooks/standard-webhooks), so receivers that
 * don't use Hookgres can verify what it sends.
 */

function headerRecord(
  headers: Record<string, unknown>,
): Record<string, string> {
  return {
    "webhook-id": String(headers["webhook-id"]),
    "webhook-timestamp": String(headers["webhook-timestamp"]),
    "webhook-signature": String(headers["webhook-signature"]),
  };
}

describe("signing interop with the standardwebhooks library", () => {
  it("produces signatures the official library accepts", () => {
    const secret = generateSecret();
    const body = JSON.stringify({ type: "a.b", data: { x: [1, "é", null] } });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      "webhook-id": "msg_1",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": sign(secret, "msg_1", timestamp, body),
    };
    expect(new Webhook(secret).verify(body, headers)).toEqual(JSON.parse(body));
  });

  it("verifies signatures made by the official library", () => {
    const secret = generateSecret();
    const body = JSON.stringify({ hello: "wörld" });
    const now = new Date();
    const headers = {
      "webhook-id": "msg_2",
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign("msg_2", now, body),
    };
    expect(verifyWebhook({ secret, headers, body })).toEqual({
      hello: "wörld",
    });
  });
});

describe("delivered webhooks verify with the standardwebhooks library", () => {
  const ctx = useHookgres();
  let receiver: Receiver;
  beforeEach(async () => {
    receiver = await startReceiver();
  });
  afterEach(async () => {
    await receiver.close();
  });

  it("accepts a real delivery, including during secret rotation", async () => {
    const hw = ctx.create();
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({
      tenantId: "acme",
      eventType: "invoice.paid",
      payload: { amount: 4200, note: "ünïcode ✓" },
    });
    await drain(hw);

    const rotated = await hw.rotateEndpointSecret(ep.id);
    await hw.send({ tenantId: "acme", eventType: "invoice.paid", payload: {} });
    await drain(hw);

    const [first, second] = receiver.requests;
    if (!first || !second || !rotated) throw new Error("missing deliveries");
    expect(
      new Webhook(ep.secret).verify(first.body, headerRecord(first.headers)),
    ).toMatchObject({ type: "invoice.paid", data: { note: "ünïcode ✓" } });
    // Both the old and the new secret verify during the grace period.
    for (const secret of [ep.secret, rotated.secret]) {
      expect(() =>
        new Webhook(secret).verify(second.body, headerRecord(second.headers)),
      ).not.toThrow();
    }
  });
});
