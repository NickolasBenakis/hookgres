/**
 * Hookgres playground: send events and watch them get delivered, retried,
 * failed and replayed, against three fake customer endpoints that run in this
 * same process.
 *
 *   docker compose up                         # Postgres + playground
 *   open http://localhost:3000
 *
 * Or against your own Postgres:
 *
 *   pnpm build && DATABASE_URL=postgres://... node examples/playground/server.ts
 */
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  type Endpoint,
  Hookgres,
  verifyWebhook,
  WebhookVerificationError,
} from "hookgres";
import pg from "pg";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";
const SCHEMA = process.env.PLAYGROUND_SCHEMA ?? "hookgres_playground";
const TENANT = "acme";

/**
 * Short timings so you can watch the whole lifecycle in under a minute: a
 * single message to `down` fails for 17s (attempts at 0s, 2s, 7s and 17s),
 * which is past the 15s disable threshold.
 * Production defaults: retries after 5s, 5m, 30m, 2h, 5h, 10h, 10h, and
 * endpoints are disabled after 5 days of failures.
 */
const RETRY_SCHEDULE = [2_000, 5_000, 10_000];
const DISABLE_AFTER_MS = 15_000;

// ----------------------------------------------------------- receivers
// Three fake customer servers. Each verifies the signature like a real
// receiver would, then answers according to its personality.

type ReceiverName = "healthy" | "flaky" | "down";

const RECEIVERS: Record<
  ReceiverName,
  { description: string; eventTypes: string[] | null }
> = {
  healthy: {
    description: "Verifies the signature and answers 204.",
    eventTypes: null,
  },
  flaky: {
    description: "Answers 503 to the first two attempts of each message.",
    eventTypes: ["invoice.paid", "invoice.refunded"],
  },
  down: {
    description:
      "Always answers 500. After 15s of failures it is disabled automatically.",
    eventTypes: ["invoice.paid"],
  },
};

interface ReceivedRequest {
  at: string;
  receiver: ReceiverName;
  webhookId: string;
  timestamp: string;
  signature: string;
  verified: boolean;
  verifyError: string | null;
  status: number;
  body: string;
}

const received: ReceivedRequest[] = [];
const flakyCounts = new Map<string, number>();
const endpointIds = new Map<ReceiverName, string>();

async function handleReceiver(
  name: ReceiverName,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const header = (key: string) => String(req.headers[key] ?? "");
  const endpointId = endpointIds.get(name);
  const endpoint = endpointId ? await hookgres.getEndpoint(endpointId) : null;

  let verified = false;
  let verifyError: string | null = null;
  try {
    if (!endpoint) throw new Error("Unknown endpoint");
    verifyWebhook({ secret: endpoint.secret, headers: req.headers, body });
    verified = true;
  } catch (error) {
    verifyError =
      error instanceof WebhookVerificationError || error instanceof Error
        ? error.message
        : String(error);
  }

  let status = verified ? 204 : 400;
  if (verified && name === "flaky") {
    const seen = (flakyCounts.get(header("webhook-id")) ?? 0) + 1;
    flakyCounts.set(header("webhook-id"), seen);
    if (seen <= 2) status = 503;
  }
  if (verified && name === "down") status = 500;

  received.unshift({
    at: new Date().toISOString(),
    receiver: name,
    webhookId: header("webhook-id"),
    timestamp: header("webhook-timestamp"),
    signature: header("webhook-signature"),
    verified,
    verifyError,
    status,
    body: body.toString(),
  });
  received.length = Math.min(received.length, 200);

  const answers: Record<number, string> = {
    204: "",
    400: `invalid signature: ${verifyError}`,
    500: "Internal Server Error (this receiver is always down)",
    503: "Service Unavailable (flaky receiver, try again)",
  };
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(answers[status]);
}

// -------------------------------------------------------------- hookgres

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const hookgres = new Hookgres({
  pool,
  schema: SCHEMA,
  retrySchedule: RETRY_SCHEDULE,
  disableEndpointAfterMs: DISABLE_AFTER_MS,
  requestTimeoutMs: 5_000,
  pollIntervalMs: 250,
  secretRotationGraceMs: 120_000,
});

async function setUp(): Promise<void> {
  await hookgres.migrate();
  const existing = await hookgres.listEndpoints(TENANT);
  for (const name of Object.keys(RECEIVERS) as ReceiverName[]) {
    const url = `http://127.0.0.1:${PORT}/receivers/${name}`;
    let endpoint = existing.find((e) => e.metadata.receiver === name);
    // Started on another port before: point the endpoint at this process.
    if (endpoint && endpoint.url !== url) {
      endpoint =
        (await hookgres.updateEndpoint(endpoint.id, { url })) ?? undefined;
    }
    endpoint ??= await hookgres.createEndpoint({
      tenantId: TENANT,
      url,
      description: RECEIVERS[name].description,
      eventTypes: RECEIVERS[name].eventTypes,
      metadata: { receiver: name },
    });
    endpointIds.set(name, endpoint.id);
  }
  hookgres.start();
}

let resetting: Promise<void> | null = null;

/** Serialised, so a double-click can't create two sets of endpoints. */
function reset(): Promise<void> {
  resetting ??= doReset().finally(() => {
    resetting = null;
  });
  return resetting;
}

async function doReset(): Promise<void> {
  await hookgres.stop();
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  received.length = 0;
  flakyCounts.clear();
  endpointIds.clear();
  await setUp();
}

async function state() {
  const endpoints = await hookgres.listEndpoints(TENANT);
  const deliveries = await hookgres.listDeliveries({ limit: 50 });
  // Everything is a plain table, so a dashboard can just use SQL.
  const { rows: messages } = await pool.query<{
    id: string;
    event_type: string;
    idempotency_key: string | null;
  }>(
    `SELECT id, event_type, idempotency_key FROM ${SCHEMA}.messages
     WHERE id = ANY ($1)`,
    [[...new Set(deliveries.map((d) => d.messageId))]],
  );
  const { rows: counts } = await pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM ${SCHEMA}.deliveries GROUP BY status`,
  );
  const byId = new Map(messages.map((m) => [m.id, m]));
  const names = new Map(
    endpoints.map((e) => [e.id, e.metadata.receiver as string]),
  );
  return {
    settings: {
      retrySchedule: RETRY_SCHEDULE,
      disableAfterMs: DISABLE_AFTER_MS,
    },
    endpoints: endpoints.map((e) => publicEndpoint(e)),
    deliveries: deliveries.map((d) => ({
      ...d,
      endpoint: names.get(d.endpointId) ?? d.endpointId,
      eventType: byId.get(d.messageId)?.event_type ?? "?",
      idempotencyKey: byId.get(d.messageId)?.idempotency_key ?? null,
    })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    received: received.slice(0, 50),
  };
}

function publicEndpoint(e: Endpoint) {
  return {
    id: e.id,
    name: e.metadata.receiver,
    url: e.url,
    description: e.description,
    eventTypes: e.eventTypes,
    disabled: e.disabled,
    disabledReason: e.disabledReason,
    failingSince: e.failingSince,
    secretPreview: `${e.secret.slice(0, 12)}…`,
  };
}

// ------------------------------------------------------------------- api

const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");

async function handleApi(
  method: string,
  path: string,
  req: IncomingMessage,
): Promise<[number, unknown]> {
  if (method === "GET" && path === "/api/state") return [200, await state()];

  if (method === "POST" && path === "/api/send") {
    const input = JSON.parse((await readBody(req)).toString() || "{}");
    if (typeof input.eventType !== "string" || !input.eventType) {
      return [400, { error: "eventType is required" }];
    }
    const result = await hookgres.send({
      tenantId: TENANT,
      eventType: input.eventType,
      payload: input.payload ?? {},
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return [200, result];
  }

  const replay = path.match(/^\/api\/deliveries\/([\w-]+)\/replay$/);
  if (method === "POST" && replay?.[1]) {
    const delivery = await hookgres.replayDelivery(replay[1]);
    return delivery
      ? [200, delivery]
      : [409, { error: "Only finished deliveries can be replayed" }];
  }

  const attempts = path.match(/^\/api\/deliveries\/([\w-]+)\/attempts$/);
  if (method === "GET" && attempts?.[1]) {
    return [200, await hookgres.listAttempts(attempts[1])];
  }

  const endpoint = path.match(
    /^\/api\/endpoints\/([\w-]+)\/(enable|disable|rotate)$/,
  );
  if (method === "POST" && endpoint?.[1]) {
    const id = endpoint[1];
    const action = endpoint[2];
    const updated =
      action === "rotate"
        ? await hookgres.rotateEndpointSecret(id)
        : await hookgres.updateEndpoint(id, { disabled: action === "disable" });
    return updated
      ? [200, publicEndpoint(updated)]
      : [404, { error: "Not found" }];
  }

  if (method === "POST" && path === "/api/reset") {
    await reset();
    return [200, { ok: true }];
  }

  return [404, { error: "Not found" }];
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (resetting) await resetting;
    const receiver = path.match(/^\/receivers\/(healthy|flaky|down)$/);
    if (method === "POST" && receiver?.[1]) {
      await handleReceiver(receiver[1] as ReceiverName, req, res);
      return;
    }
    if (method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    const [status, body] = await handleApi(method, path, req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (error as Error).message }));
  }
});

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

await setUp();
server.listen(PORT, HOST, () => {
  console.log(`Hookgres playground: http://localhost:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await hookgres.stop();
    await pool.end();
    process.exit(0);
  });
}
