// A minimal MCP server with Events webhook delivery, to try check.mjs on.
//
//   PORT=3001 DATABASE_URL=postgres://... node example-server.mjs           # hookgres/mcp-events
//   PORT=3001 node example-server.mjs --broken                               # a naive sender
//
// POST /mcp takes JSON-RPC; "Authorization: Bearer test-token" is the
// principal "tester". POST /emit emits one incident.created event.
// Run `pnpm build` first: it imports hookgres from ../../dist.
import { createHash, createHmac, randomBytes } from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT ?? 3001);
const broken = process.argv.includes("--broken");
const EVENT = {
  name: "incident.created",
  description: "A new incident",
  inputSchema: { type: "object", properties: {} },
};

const backend = broken ? naiveBackend() : await hookgresBackend();

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const send = (status, body) =>
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    if (req.url === "/emit" && req.method === "POST") {
      const n = await backend.emit({
        title: "Database down",
        at: new Date().toISOString(),
      });
      return send(200, { queued: n });
    }
    if (req.url !== "/mcp" || req.method !== "POST") return send(404, {});
    let message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(400, {});
    }
    const principal =
      req.headers.authorization === "Bearer test-token" ? "tester" : null;
    const reply = (result) =>
      send(200, { jsonrpc: "2.0", id: message.id, result });
    const fail = (error) =>
      send(200, { jsonrpc: "2.0", id: message.id, error });
    try {
      if (
        message.method === "server/discover" ||
        message.method === "initialize"
      ) {
        return reply({
          resultType: "complete",
          protocolVersion: "2026-07-28",
          serverInfo: { name: "mcp-events-example", version: "0.1.0" },
          capabilities: {
            extensions: { "io.modelcontextprotocol/events": {} },
          },
        });
      }
      return reply(
        await backend.handle(message.method, message.params, principal),
      );
    } catch (error) {
      if (typeof error?.code === "number")
        return fail(error.toJSON?.() ?? error);
      console.error(error);
      return fail({ code: -32603, message: "Internal error" });
    }
  });
});
server.listen(port, "127.0.0.1", () => console.log(`ready on ${port}`));
process.on("SIGTERM", async () => {
  server.close();
  await backend.stop();
  process.exit(0);
});

async function hookgresBackend() {
  const pg = (await import("pg")).default;
  const { McpEvents } = await import("../../dist/mcp-events.js");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const events = new McpEvents({
    pool,
    schema: process.env.SCHEMA ?? "mcp_events_example",
    events: [EVENT],
    // The checker's receiver runs on this machine.
    insecure: { allowAddresses: ["127.0.0.1"] },
    // Short retries so a check run takes a minute, not fifteen.
    hookgres: { retrySchedule: [2000, 4000, 8000], pollIntervalMs: 200 },
  });
  await events.migrate();
  events.start();
  return {
    handle: (method, params, principal) =>
      events.handle(method, params, { principal }),
    emit: (data) => events.emit("incident.created", data),
    stop: async () => {
      await events.stop();
      await pool.end();
    },
  };
}

// What a quick hand-rolled sender often looks like. Deliberately wrong:
// no endpoint verification or input checks, webhook-id derived from the
// event id, redirects followed, 410 retried, no dual-signing on rotation,
// and subscriptions kept in memory.
function naiveBackend() {
  const subs = new Map();
  const deliver = async (sub, eventId, body, attempt = 0) => {
    const ts = Math.floor(Date.now() / 1000);
    const key = Buffer.from(sub.secret.slice(6), "base64");
    const signature = createHmac("sha256", key)
      .update(`msg_${eventId}.${ts}.${body}`)
      .digest("base64");
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "webhook-id": `msg_${eventId}`,
          "webhook-timestamp": String(ts),
          "webhook-signature": `v1,${signature}`,
          "x-mcp-subscription-id": sub.id,
        },
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      if (attempt < 4)
        setTimeout(() => deliver(sub, eventId, body, attempt + 1), 1000);
    }
  };
  return {
    async handle(method, params) {
      if (method === "events/list") {
        return {
          resultType: "complete",
          events: [{ ...EVENT, delivery: ["webhook"] }],
        };
      }
      if (method === "events/subscribe") {
        if (params.name !== EVENT.name)
          throw { code: -32023, message: "NotFound" };
        const id = `sub_${createHash("sha256").update(params.delivery.url).digest("hex").slice(0, 16)}`;
        subs.set(params.delivery.url, {
          id,
          url: params.delivery.url,
          secret: params.delivery.secret,
        });
        return {
          resultType: "complete",
          id,
          refreshBefore: new Date(Date.now() + 3_600_000).toISOString(),
          cursor: null,
          truncated: false,
        };
      }
      if (method === "events/unsubscribe") {
        subs.delete(params.delivery.url);
        return { resultType: "complete" };
      }
      throw { code: -32601, message: "Method not found" };
    },
    async emit(data) {
      const eventId = `evt_${randomBytes(8).toString("hex")}`;
      const body = JSON.stringify({
        eventId,
        name: EVENT.name,
        timestamp: new Date().toISOString(),
        data,
        cursor: null,
      });
      for (const sub of subs.values()) void deliver(sub, eventId, body);
      return subs.size;
    },
    async stop() {},
  };
}
