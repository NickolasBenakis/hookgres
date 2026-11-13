import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
} from "vitest";
import { verifyWebhook } from "../src/index.js";
import {
  McpEvents,
  McpEventsErrorCode,
  subscriptionId,
} from "../src/mcp-events.js";
import { drain, type Receiver, startReceiver } from "./helpers.js";

const schema = `mcp_${randomBytes(6).toString("hex")}`;
let pool: pg.Pool;
let events: McpEvents;
let receiver: Receiver;
const secret = `whsec_${randomBytes(32).toString("base64")}`;

function create(
  overrides: Partial<ConstructorParameters<typeof McpEvents>[0]> = {},
) {
  return new McpEvents({
    pool,
    schema,
    events: [
      {
        name: "incident.created",
        description: "A new incident",
        inputSchema: {
          type: "object",
          properties: { severity: { type: "string" } },
        },
        matches: (args, data) =>
          args.severity === undefined ||
          args.severity === (data as { severity?: string }).severity,
      },
      { name: "deploy.finished" },
    ],
    insecure: { allowHttp: true, allowAddresses: ["127.0.0.1"] },
    hookgres: { retrySchedule: [0, 0], pollIntervalMs: 20 },
    ...overrides,
  });
}

/** Echoes verification challenges; answers deliveries with `respond`. */
function echoChallenges() {
  const respond = receiver.respond;
  receiver.respond = (n, request) => {
    const body = JSON.parse(request.body || "{}");
    if (body.type === "verification") {
      receiver.body = JSON.stringify({ challenge: body.challenge });
      return 200;
    }
    receiver.body = undefined;
    return respond(n, request);
  };
}

const deliveries = () =>
  receiver.requests.filter((r) => !r.body.includes('"type":"verification"'));

async function subscribe(
  params: Record<string, unknown> = {},
  principal = "user_1",
) {
  return events.handle(
    "events/subscribe",
    {
      name: "incident.created",
      arguments: {},
      delivery: { mode: "webhook", url: receiver.url, secret },
      ...params,
    },
    { principal },
  );
}

async function expectError(
  promise: Promise<unknown>,
  code: number,
  data?: object,
) {
  const error = await promise.then(
    () => {
      throw new Error("expected an error");
    },
    (e) => e,
  );
  expect(error.code).toBe(code);
  if (data) expect(error.data).toMatchObject(data);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 10 });
  await create().migrate();
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});
beforeEach(async () => {
  receiver = await startReceiver();
  echoChallenges();
  events = create();
});
afterEach(async () => {
  await events.stop();
  await receiver.close();
  await pool.query(
    `TRUNCATE "${schema}".endpoints, "${schema}".messages CASCADE`,
  );
});

describe("events/list", () => {
  it("lists event types with webhook delivery", async () => {
    const result = await events.handle("events/list", {}, {});
    expect(result).toMatchObject({
      resultType: "complete",
      events: [
        {
          name: "incident.created",
          delivery: ["webhook"],
          description: "A new incident",
        },
        {
          name: "deploy.finished",
          delivery: ["webhook"],
          inputSchema: { type: "object" },
        },
      ],
    });
  });

  it("advertises the extension", () => {
    expect(events.capabilities).toEqual({
      extensions: { "io.modelcontextprotocol/events": {} },
    });
  });
});

describe("events/subscribe", () => {
  it("verifies the endpoint with a signed challenge, then subscribes", async () => {
    const result = await subscribe();
    expect(result).toMatchObject({
      resultType: "complete",
      cursor: null,
      truncated: false,
    });
    expect(result.id).toBe(
      subscriptionId("user_1", receiver.url, "incident.created", {}),
    );
    expect(Date.parse(String(result.refreshBefore))).toBeGreaterThan(
      Date.now(),
    );

    const [challenge] = receiver.requests;
    expect(challenge?.headers["x-mcp-subscription-id"]).toBe(result.id);
    expect(challenge?.headers["webhook-id"]).toMatch(/^msg_verification_/);
    expect(() =>
      verifyWebhook({
        secret,
        headers: challenge?.headers ?? {},
        body: challenge?.body ?? "",
      }),
    ).not.toThrow();
  });

  it("fails with challenge_failed when the endpoint doesn't echo", async () => {
    receiver.respond = () => 200;
    receiver.body = "ok";
    await expectError(subscribe(), McpEventsErrorCode.CallbackEndpointError, {
      reason: "challenge_failed",
    });
  });

  it("verifies once per (principal, url), across arguments", async () => {
    await subscribe();
    await subscribe({ arguments: { severity: "P1" } });
    const challenges = receiver.requests.filter((r) =>
      r.body.includes("verification"),
    );
    expect(challenges).toHaveLength(1);
  });

  it("rejects unauthenticated, http, bad-secret and unknown-event requests", async () => {
    await expectError(subscribe({}, ""), McpEventsErrorCode.Forbidden);
    await expectError(
      subscribe({ delivery: { url: receiver.url, secret: "whsec_short" } }),
      McpEventsErrorCode.InvalidParams,
    );
    await expectError(
      subscribe({ name: "nope" }),
      McpEventsErrorCode.NotFound,
      {
        kind: "event",
      },
    );
    const strict = create({ insecure: undefined });
    await expectError(
      strict.handle(
        "events/subscribe",
        { name: "incident.created", delivery: { url: receiver.url, secret } },
        { principal: "user_1" },
      ),
      McpEventsErrorCode.InvalidParams,
    );
  });

  it("derives ids per principal", () => {
    const a = subscriptionId("a", "https://x/h", "incident.created", {
      s: 1,
      t: 2,
    });
    expect(
      subscriptionId("a", "https://x/h", "incident.created", { t: 2, s: 1 }),
    ).toBe(a);
    expect(
      subscriptionId("b", "https://x/h", "incident.created", { s: 1, t: 2 }),
    ).not.toBe(a);
  });

  it("clamps the suggested TTL and grants no expiry only when allowed", async () => {
    const short = await subscribe({ ttlMs: 1 });
    expect(
      Date.parse(String(short.refreshBefore)) - Date.now(),
    ).toBeGreaterThan(50_000);
    const none = await subscribe({ ttlMs: null });
    expect(none.refreshBefore).not.toBeNull();
  });
});

describe("emit and delivery", () => {
  it("delivers only when the emitting transaction commits", async () => {
    const { id } = await subscribe();

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await events.emit("incident.created", { n: 1 }, { client });
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await events.emit(
        "incident.created",
        { n: 2 },
        { client, eventId: "evt_up_2" },
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await drain(events.hookgres);

    const got = deliveries();
    expect(got).toHaveLength(1);
    const request = got[0];
    if (!request) throw new Error("no delivery");
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      eventId: "evt_up_2",
      name: "incident.created",
      data: { n: 2 },
      cursor: null,
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(request.headers["x-mcp-subscription-id"]).toBe(id);
    expect(request.headers["webhook-id"]).not.toContain("evt_up_2");
    expect(() =>
      verifyWebhook({ secret, headers: request.headers, body: request.body }),
    ).not.toThrow();
  });

  it("routes by arguments and gives each subscription its own webhook-id", async () => {
    await subscribe({ arguments: { severity: "P1" } });
    await subscribe({ arguments: {} });
    await events.emit("incident.created", { severity: "P2" });
    await events.emit("incident.created", { severity: "P1" });
    await drain(events.hookgres);

    const got = deliveries();
    expect(got).toHaveLength(3);
    expect(new Set(got.map((r) => r.headers["webhook-id"])).size).toBe(3);
  });

  it("treats 410 as final for that delivery only", async () => {
    await subscribe();
    let n = 0;
    receiver.respond = (_, request) => {
      if (request.body.includes("verification")) return 200;
      n++;
      return n === 1 ? 410 : 200;
    };
    await events.emit("incident.created", { n: 1 });
    await drain(events.hookgres);
    await events.emit("incident.created", { n: 2 });
    await drain(events.hookgres);
    expect(deliveries().map((r) => JSON.parse(r.body).data.n)).toEqual([1, 2]);
  });

  it("dual-signs after the client rotates its secret on refresh", async () => {
    await subscribe();
    const next = `whsec_${randomBytes(32).toString("base64")}`;
    const refreshed = await subscribe({
      delivery: { mode: "webhook", url: receiver.url, secret: next },
    });
    expect(refreshed.deliveryStatus).toMatchObject({ active: true });
    await events.emit("incident.created", {});
    await drain(events.hookgres);
    const request = deliveries()[0];
    if (!request) throw new Error("no delivery");
    for (const s of [secret, next]) {
      expect(() =>
        verifyWebhook({
          secret: s,
          headers: request.headers,
          body: request.body,
        }),
      ).not.toThrow();
    }
  });

  it("stops after unsubscribe and after expiry", async () => {
    await subscribe();
    await events.handle(
      "events/unsubscribe",
      {
        name: "incident.created",
        arguments: {},
        delivery: { url: receiver.url },
      },
      { principal: "user_1" },
    );
    await expectError(
      events.handle(
        "events/unsubscribe",
        {
          name: "incident.created",
          arguments: {},
          delivery: { url: receiver.url },
        },
        { principal: "user_1" },
      ),
      McpEventsErrorCode.NotFound,
      { kind: "subscription" },
    );
    const expiring = create({ ttl: { minMs: 1, defaultMs: 1 } });
    await expiring.handle(
      "events/subscribe",
      { name: "deploy.finished", delivery: { url: receiver.url, secret } },
      { principal: "user_1" },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await events.emit("incident.created", {})).toBe(0);
    expect(await expiring.emit("deploy.finished", {})).toBe(0);
    expect(await expiring.deleteExpired()).toBe(1);
    await expiring.stop();
  });

  it("answers poll and push with Unsupported", async () => {
    await expectError(
      events.handle("events/poll", {}, {}),
      McpEventsErrorCode.Unsupported,
      {
        value: "poll",
      },
    );
  });
});
