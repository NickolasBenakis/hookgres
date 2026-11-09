import type { LookupAddress } from "node:dns";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Hookgres,
  isPrivateAddress,
  verifyWebhook,
  type WebhookEnvelope,
} from "../src/index.js";
import { AddressGuard } from "../src/ssrf.js";
import {
  closedPortUrl,
  drain,
  type Receiver,
  startReceiver,
  useHookgres,
} from "./helpers.js";

describe("isPrivateAddress", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700::1111",
    "2a00:1450:4001::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::",
    "not-an-ip",
  ])("allows %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "fec0::1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::FFFF:A9FE:A9FE",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::a00:1",
    "2002:7f00:1::",
    "2002:c0a8:101::1",
    "ff02::1",
    "[::1]",
    "[fd00::1]",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });
});

describe("AddressGuard", () => {
  it("lets allowed IPv4 CIDRs and IPv6 addresses through", () => {
    const guard = new AddressGuard({
      allow: ["10.1.2.0/24", "fd00::5", "127.0.0.1"],
    });
    expect(guard.isBlocked("10.1.2.200")).toBe(false);
    expect(guard.isBlocked("10.1.3.1")).toBe(true);
    expect(guard.isBlocked("fd00::5")).toBe(false);
    expect(guard.isBlocked("fd00::6")).toBe(true);
    expect(guard.isBlocked("::ffff:127.0.0.1")).toBe(false);
    expect(guard.isBlocked("127.0.0.2")).toBe(true);
    expect(guard.isBlocked("8.8.8.8")).toBe(false);
  });

  it.each([
    "nope",
    "10.0.0.0/33",
    "::/129",
    "10.0.0.0/x",
    "10.0.0.0/",
    "10.0.0.0/8/8",
    "fe80::1%eth0",
    "example.com",
  ])("rejects the allow entry %s", (entry) => {
    expect(() => new AddressGuard({ allow: [entry] })).toThrow(
      /Invalid blockPrivateAddresses.allow entry/,
    );
  });

  it("rejects an allow that isn't an array of strings", () => {
    expect(
      () => new AddressGuard({ allow: "10.0.0.0/8" as unknown as string[] }),
    ).toThrow(/must be an array/);
    expect(
      () => new AddressGuard({ allow: [10] as unknown as string[] }),
    ).toThrow(/Invalid blockPrivateAddresses.allow entry 10/);
  });

  describe("lookup", () => {
    const resolveTo =
      (addresses: LookupAddress[], error: Error | null = null) =>
      (
        _host: string,
        _options: { all: true },
        callback: (error: Error | null, addresses: LookupAddress[]) => void,
      ) =>
        callback(error, addresses);

    const run = (
      guard: AddressGuard,
      resolver: ReturnType<typeof resolveTo>,
      all: boolean,
    ) =>
      new Promise<{ error: Error | null; address: unknown; family?: number }>(
        (resolve) =>
          guard.lookup(resolver)(
            "hooks.example.com",
            { all },
            (error, address, family) => resolve({ error, address, family }),
          ),
      );

    it("fails if any resolved address is blocked", async () => {
      const result = await run(
        new AddressGuard(true),
        resolveTo([
          { address: "93.184.215.14", family: 4 },
          { address: "10.0.0.7", family: 4 },
          { address: "2606:4700::1111", family: 6 },
        ]),
        true,
      );
      expect(result.error?.message).toBe("Blocked private address 10.0.0.7");
    });

    it("returns the checked addresses when all are public", async () => {
      const addresses = [
        { address: "93.184.215.14", family: 4 },
        { address: "2606:4700::1111", family: 6 },
      ];
      const guard = new AddressGuard(true);
      expect(await run(guard, resolveTo(addresses), true)).toEqual({
        error: null,
        address: addresses,
        family: undefined,
      });
      expect(await run(guard, resolveTo(addresses), false)).toEqual({
        error: null,
        address: "93.184.215.14",
        family: 4,
      });
    });

    it("passes on resolver errors and empty answers", async () => {
      const guard = new AddressGuard(true);
      const notFound = new Error("getaddrinfo ENOTFOUND");
      expect((await run(guard, resolveTo([], notFound), true)).error).toBe(
        notFound,
      );
      expect((await run(guard, resolveTo([]), true)).error?.message).toBe(
        "No address for hooks.example.com",
      );
    });
  });
});

describe("blockPrivateAddresses", () => {
  const ctx = useHookgres();
  let receiver: Receiver;
  beforeEach(async () => {
    receiver = await startReceiver();
  });
  afterEach(async () => {
    await receiver.close();
  });

  /** Creates the endpoint without the guard, as if it predates the option. */
  async function endpointFor(url: string) {
    return ctx.create().createEndpoint({ tenantId: "acme", url });
  }

  async function sendAndDrain(hw: Hookgres) {
    const { message } = await hw.send({
      tenantId: "acme",
      eventType: "invoice.paid",
      payload: { amount: 4200 },
    });
    await drain(hw);
    const [delivery] = await hw.listDeliveries({ messageId: message.id });
    if (!delivery) throw new Error("no delivery");
    return { message, delivery, attempts: await hw.listAttempts(delivery.id) };
  }

  it("rejects private and localhost URLs at create and update time", async () => {
    const hw = ctx.create({ blockPrivateAddresses: true });
    for (const url of [
      "http://2130706433/",
      "http://0x7f.1/",
      "http://127.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::1]:8080/",
      "http://169.254.169.254/latest/meta-data",
      "https://10.0.0.5:6379/",
      "http://localhost/",
      "http://LOCALHOST./",
      "http://foo.localhost/",
    ]) {
      await expect(
        hw.createEndpoint({ tenantId: "acme", url }),
        url,
      ).rejects.toThrow(/points to a private address/);
    }
    const ep = await hw.createEndpoint({
      tenantId: "acme",
      url: "https://hooks.example.com/in",
    });
    await expect(
      hw.updateEndpoint(ep.id, { url: "http://192.168.0.1/" }),
    ).rejects.toThrow(/points to a private address/);
    await hw.createEndpoint({ tenantId: "acme", url: "https://8.8.8.8/" });
  });

  it("accepts the same URLs when off, or when allowed", async () => {
    const off = ctx.create();
    for (const url of ["http://2130706433/", "http://localhost/"]) {
      await off.createEndpoint({ tenantId: "acme", url });
    }
    const allowed = ctx.create({
      blockPrivateAddresses: { allow: ["127.0.0.0/8"] },
    });
    await allowed.createEndpoint({ tenantId: "acme", url: "http://0x7f.1/" });
    await expect(
      allowed.createEndpoint({ tenantId: "acme", url: "http://localhost/" }),
    ).rejects.toThrow(/points to a private address/);
  });

  it("fails attempts to a blocked IP without sending anything", async () => {
    await endpointFor(receiver.url);
    const hw = ctx.create({ blockPrivateAddresses: true });
    const { delivery, attempts } = await sendAndDrain(hw);

    expect(receiver.requests).toHaveLength(0);
    expect(delivery).toMatchObject({
      status: "failed",
      attemptCount: 3,
      lastError: "Blocked private address 127.0.0.1",
    });
    expect(attempts.map((a) => a.statusCode)).toEqual([null, null, null]);
  });

  it("blocks hostnames that resolve to a private address", async () => {
    await endpointFor(receiver.url.replace("127.0.0.1", "localhost"));
    const hw = ctx.create({ blockPrivateAddresses: true, retrySchedule: [] });
    const { delivery } = await sendAndDrain(hw);

    expect(receiver.requests).toHaveLength(0);
    expect(delivery.lastError).toMatch(
      /^Blocked private address (127\.0\.0\.1|::1)$/,
    );
  });

  it("delivers to allowed addresses like fetch does", async () => {
    const ep = await endpointFor(`${receiver.url}?x=1`);
    const hw = ctx.create({
      blockPrivateAddresses: { allow: ["127.0.0.1/32"] },
      userAgent: "Test/1",
    });
    receiver.body = "x".repeat(10_000);
    const { message, delivery, attempts } = await sendAndDrain(hw);

    expect(receiver.requests).toHaveLength(1);
    const request = receiver.requests[0];
    if (!request) throw new Error("no request");
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/webhooks?x=1");
    expect(request.headers).toMatchObject({
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(request.body)),
      "user-agent": "Test/1",
      "webhook-id": message.id,
      host: new URL(receiver.url).host,
    });
    expect(request.headers["transfer-encoding"]).toBeUndefined();
    expect(
      verifyWebhook<WebhookEnvelope>({
        secret: ep.secret,
        headers: request.headers,
        body: request.body,
      }),
    ).toEqual({
      type: "invoice.paid",
      timestamp: message.createdAt.toISOString(),
      data: { amount: 4200 },
    });
    expect(delivery).toMatchObject({ status: "succeeded", attemptCount: 1 });
    expect(attempts[0]).toMatchObject({
      statusCode: 200,
      responseBody: "x".repeat(4096),
      error: null,
    });
  });

  it("treats redirects, error codes, timeouts and refused connections as failures", async () => {
    const hw = ctx.create({
      blockPrivateAddresses: { allow: ["127.0.0.1"] },
      retrySchedule: [0, 0, 0],
      requestTimeoutMs: 200,
      lockTimeoutMs: 5000,
    });
    await hw.createEndpoint({ tenantId: "acme", url: receiver.url });
    receiver.respond = async (n) => {
      if (n === 1) return 302;
      if (n === 2) return 500;
      if (n === 3) await new Promise((resolve) => setTimeout(resolve, 500));
      return 204;
    };
    const { delivery, attempts } = await sendAndDrain(hw);

    expect(attempts.map((a) => [a.statusCode, a.error])).toEqual([
      [302, "HTTP 302"],
      [500, "HTTP 500"],
      [null, "Timed out after 200ms"],
      [204, null],
    ]);
    expect(delivery.status).toBe("succeeded");

    await hw.updateEndpoint(delivery.endpointId, {
      url: await closedPortUrl(),
    });
    const refused = await sendAndDrain(hw);
    expect(refused.delivery.lastError).toMatch(/ECONNREFUSED/);
  });

  it("names the error when every resolved address refuses", async () => {
    // localhost usually resolves to both ::1 and 127.0.0.1, so Node fails
    // with an AggregateError that has an empty message.
    await endpointFor(
      (await closedPortUrl()).replace("127.0.0.1", "localhost"),
    );
    const hw = ctx.create({
      blockPrivateAddresses: { allow: ["127.0.0.1", "::1"] },
      retrySchedule: [],
    });
    const { delivery } = await sendAndDrain(hw);
    expect(delivery.lastError).toMatch(/ECONNREFUSED/);
  });

  it("refuses URLs with credentials, like fetch", async () => {
    await endpointFor(`http://user:pass@${new URL(receiver.url).host}/`);
    const hw = ctx.create({
      blockPrivateAddresses: { allow: ["127.0.0.1"] },
      retrySchedule: [],
    });
    const { delivery } = await sendAndDrain(hw);
    expect(receiver.requests).toHaveLength(0);
    expect(delivery.lastError).toBe(
      "Endpoint URL must not contain credentials",
    );
  });

  it("checks https URLs too", async () => {
    await endpointFor("https://127.0.0.1:1/");
    const hw = ctx.create({ blockPrivateAddresses: true, retrySchedule: [] });
    const { delivery } = await sendAndDrain(hw);
    expect(delivery.lastError).toBe("Blocked private address 127.0.0.1");
  });

  it("can't be combined with a custom fetch, and validates allow", () => {
    expect(() =>
      ctx.create({ blockPrivateAddresses: true, fetch: globalThis.fetch }),
    ).toThrow(/custom fetch.*Smokescreen/);
    expect(() =>
      ctx.create({ blockPrivateAddresses: { allow: ["10.0.0.0/40"] } }),
    ).toThrow(/Invalid blockPrivateAddresses.allow entry "10.0.0.0\/40"/);
    expect(() =>
      ctx.create({ blockPrivateAddresses: false, fetch: globalThis.fetch }),
    ).not.toThrow();
  });
});
