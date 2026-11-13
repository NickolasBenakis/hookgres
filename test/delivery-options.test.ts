import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookgresValidationError, verifyWebhook } from "../src/index.js";
import { drain, type Receiver, startReceiver, useHookgres } from "./helpers.js";

const ctx = useHookgres();
let receiver: Receiver;

beforeEach(async () => {
  receiver = await startReceiver();
});
afterEach(async () => {
  await receiver.close();
});

describe("envelope: false", () => {
  it("sends the payload itself as the signed body", async () => {
    const hw = ctx.create({ envelope: false });
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    const payload = {
      eventId: "evt_1",
      name: "incident.created",
      data: { a: 1 },
    };
    await hw.send({ tenantId: "acme", eventType: "incident.created", payload });
    await drain(hw);

    expect(receiver.requests).toHaveLength(1);
    const request = receiver.requests[0];
    if (!request) throw new Error("no request");
    expect(JSON.parse(request.body)).toEqual(payload);
    expect(() =>
      verifyWebhook({
        secret: ep.secret,
        headers: request.headers,
        body: request.body,
      }),
    ).not.toThrow();
  });

  it("keeps the Standard Webhooks envelope by default", async () => {
    const hw = ctx.create();
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({ tenantId: "acme", eventType: "a.b", payload: { x: 1 } });
    await drain(hw);
    const body = JSON.parse(receiver.requests[0]?.body ?? "{}");
    expect(body).toMatchObject({ type: "a.b", data: { x: 1 } });
  });

  it("rejects a non-boolean", () => {
    expect(() => ctx.create({ envelope: "no" as unknown as boolean })).toThrow(
      HookgresValidationError,
    );
  });
});

describe("deliveryHeaders", () => {
  it("adds headers to every attempt, with the attempt number", async () => {
    const seen: number[] = [];
    const hw = ctx.create({
      deliveryHeaders: ({ tenantId, attemptNumber }) => {
        seen.push(attemptNumber);
        return { "X-Account-Id": tenantId };
      },
    });
    receiver.respond = (n) => (n === 1 ? 500 : 200);
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({ tenantId: "acme", eventType: "a.b", payload: {} });
    await drain(hw);

    expect(receiver.requests).toHaveLength(2);
    for (const request of receiver.requests) {
      expect(request.headers["x-account-id"]).toBe("acme");
    }
    expect(seen).toEqual([1, 2]);
  });

  it("can't override the signature headers: the attempt fails and is retried", async () => {
    let calls = 0;
    const hw = ctx.create({
      deliveryHeaders: () => {
        calls++;
        return calls === 1
          ? { "Webhook-Id": "forged" }
          : ({} as Record<string, string>);
      },
    });
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({ tenantId: "acme", eventType: "a.b", payload: {} });
    await drain(hw);

    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0]?.headers["webhook-id"]).not.toBe("forged");
    const [delivery] = await hw.listDeliveries({ endpointId: ep.id });
    const attempts = await hw.listAttempts(delivery?.id ?? "");
    expect(attempts[0]?.error).toContain(`can't set "webhook-id"`);
    expect(delivery?.status).toBe("succeeded");
  });

  it("rejects a non-function", () => {
    expect(() =>
      ctx.create({
        deliveryHeaders: {} as unknown as () => Record<string, string>,
      }),
    ).toThrow(HookgresValidationError);
  });
});

describe("nonRetryableStatuses", () => {
  it("fails the delivery on the first such response, without retries", async () => {
    const hw = ctx.create({ nonRetryableStatuses: [410, 413] });
    receiver.respond = () => 410;
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({ tenantId: "acme", eventType: "a.b", payload: {} });
    await drain(hw);

    expect(receiver.requests).toHaveLength(1);
    const [delivery] = await hw.listDeliveries({ endpointId: ep.id });
    expect(delivery?.status).toBe("failed");
  });

  it("doesn't count against the endpoint's health", async () => {
    const hw = ctx.create({
      nonRetryableStatuses: [410],
      disableEndpointAfterMs: 1,
    });
    receiver.respond = () => 410;
    const ep = await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({ tenantId: "acme", eventType: "a.b", payload: {} });
    await drain(hw);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await hw.send({ tenantId: "acme", eventType: "a.b", payload: {} });
    await drain(hw);

    const endpoint = await hw.getEndpoint(ep.id);
    expect(endpoint?.disabled).toBe(false);
    expect(endpoint?.failingSince).toBeNull();
    expect(receiver.requests).toHaveLength(2);
  });

  it("still retries other statuses", async () => {
    const hw = ctx.create({ nonRetryableStatuses: [410] });
    receiver.respond = (n) => (n === 1 ? 500 : 200);
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    await hw.send({ tenantId: "acme", eventType: "a.b", payload: {} });
    await drain(hw);
    expect(receiver.requests).toHaveLength(2);
  });

  it("rejects values that aren't 300-599 status codes", () => {
    for (const bad of [[200], [600], [410.5], "410"]) {
      expect(() =>
        ctx.create({ nonRetryableStatuses: bad as unknown as number[] }),
      ).toThrow(HookgresValidationError);
    }
  });
});
