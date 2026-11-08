import { describe, expect, it } from "vitest";
import {
  assertSecret,
  generateSecret,
  sign,
  verifyWebhook,
  WebhookVerificationError,
} from "../src/index.js";

describe("signing", () => {
  const secret = generateSecret();
  const id = "msg_test";
  const body = JSON.stringify({ type: "invoice.paid", data: { amount: 10 } });
  const now = Date.now();
  const timestamp = Math.floor(now / 1000);
  const headers = (signature: string, ts = timestamp) => ({
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": signature,
  });

  it("generates whsec_ secrets with 24 random bytes", () => {
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(generateSecret()).not.toBe(secret);
  });

  it("matches the Standard Webhooks reference vector", () => {
    // From https://github.com/standard-webhooks/standard-webhooks (spec tests).
    const signature = sign(
      "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      "msg_p5jXN8AQM9LWM0D4loKWxJek",
      1614265330,
      '{"test": 2432232314}',
    );
    expect(signature).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("verifies a valid signature and returns the parsed body", () => {
    const payload = verifyWebhook({
      secret,
      headers: headers(sign(secret, id, timestamp, body)),
      body,
      now,
    });
    expect(payload).toEqual({ type: "invoice.paid", data: { amount: 10 } });
  });

  it("accepts any matching signature among several (secret rotation)", () => {
    const old = generateSecret();
    const signature = `${sign(secret, id, timestamp, body)} ${sign(old, id, timestamp, body)}`;
    expect(() =>
      verifyWebhook({ secret: old, headers: headers(signature), body, now }),
    ).not.toThrow();
  });

  it("works with a Headers instance and Buffer body", () => {
    const h = new Headers(headers(sign(secret, id, timestamp, body)));
    expect(() =>
      verifyWebhook({ secret, headers: h, body: Buffer.from(body), now }),
    ).not.toThrow();
  });

  it("rejects a tampered body", () => {
    expect(() =>
      verifyWebhook({
        secret,
        headers: headers(sign(secret, id, timestamp, body)),
        body: body.replace("10", "1000"),
        now,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects the wrong secret", () => {
    expect(() =>
      verifyWebhook({
        secret: generateSecret(),
        headers: headers(sign(secret, id, timestamp, body)),
        body,
        now,
      }),
    ).toThrow(/No matching webhook signature/);
  });

  it("rejects timestamps outside the tolerance", () => {
    const old = timestamp - 301;
    expect(() =>
      verifyWebhook({
        secret,
        headers: headers(sign(secret, id, old, body), old),
        body,
        now,
      }),
    ).toThrow(/outside tolerance/);
  });

  it("rejects missing headers", () => {
    expect(() => verifyWebhook({ secret, headers: {}, body, now })).toThrow(
      /Missing required webhook headers/,
    );
  });
});

describe("verifyWebhook input errors", () => {
  const secret = generateSecret();
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const body = "{}";

  it("throws WebhookVerificationError for a parsed body or bad secret", () => {
    const headers = {
      "webhook-id": "msg_1",
      "webhook-timestamp": ts,
      "webhook-signature": sign(secret, "msg_1", Number(ts), body),
    };
    expect(() =>
      verifyWebhook({ secret, headers, body: {} as unknown as string, now }),
    ).toThrow(WebhookVerificationError);
    expect(() =>
      verifyWebhook({ secret: "whsec_", headers, body, now }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects when none of several signatures match", () => {
    const other = generateSecret();
    const headers = {
      "webhook-id": "msg_1",
      "webhook-timestamp": ts,
      "webhook-signature": `${sign(other, "msg_1", Number(ts), body)} v1,AAAA v2,zzz`,
    };
    expect(() => verifyWebhook({ secret, headers, body, now })).toThrow(
      /No matching/,
    );
  });

  it("validates secrets with assertSecret", () => {
    expect(assertSecret(secret)).toBe(secret);
    expect(() => assertSecret("whsec_c2hvcnQ=")).toThrow();
  });
});
