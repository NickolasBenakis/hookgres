/**
 * End-to-end example: a receiver that verifies signatures, and an app that
 * sends it a webhook through Hookgres.
 *
 *   DATABASE_URL=postgres://... node examples/basic.ts
 *
 * (Node 22.18+ runs TypeScript files directly. Build first with `pnpm build`.)
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hookgres, verifyWebhook, type WebhookEnvelope } from "hookgres";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");

// --- The receiving side (your customer's server) ---------------------------

let secret = "";
let resolveReceived: (event: WebhookEnvelope) => void;
const received = new Promise<WebhookEnvelope>((resolve) => {
  resolveReceived = resolve;
});

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const event = verifyWebhook<WebhookEnvelope>({
        secret,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(204).end();
      resolveReceived(event);
    } catch {
      res.writeHead(400).end("invalid signature");
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

// --- The sending side (your app) -------------------------------------------

const pool = new pg.Pool({ connectionString: databaseUrl });
const hookgres = new Hookgres({ pool, schema: "hookgres_example" });
await hookgres.migrate();
hookgres.start();

const endpoint = await hookgres.createEndpoint({
  tenantId: "acme",
  url: `http://127.0.0.1:${port}/webhooks`,
  eventTypes: ["invoice.paid"],
});
secret = endpoint.secret; // in real life, shown once to your customer

const { message } = await hookgres.send({
  tenantId: "acme",
  eventType: "invoice.paid",
  payload: { invoiceId: "in_123", amount: 4200, currency: "eur" },
});

const timeout = setTimeout(() => {
  console.error("No webhook received within 10s");
  process.exit(1);
}, 10_000);
const event = await received;
clearTimeout(timeout);
console.log(`Received ${event.type} for message ${message.id}:`, event.data);

await hookgres.stop();
await pool.query("DROP SCHEMA hookgres_example CASCADE");
await pool.end();
server.close();
