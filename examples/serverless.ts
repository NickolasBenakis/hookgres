/**
 * No long-running worker: call `runOnce()` from a cron job or a scheduled
 * serverless function until there is nothing left to send.
 *
 *   docker compose up -d postgres && pnpm build && node examples/serverless.ts
 */
import { Hookgres } from "hookgres";
import pg from "pg";
import { databaseUrl, startReceiver } from "./receiver.ts";

const pool = new pg.Pool({ connectionString: databaseUrl });
const hookgres = new Hookgres({ pool, schema: "hookgres_ex_serverless" });
await hookgres.migrate();

let secret = "";
const receiver = await startReceiver({ secret: () => secret });
const endpoint = await hookgres.createEndpoint({
  tenantId: "acme",
  url: receiver.url,
});
secret = endpoint.secret;

for (let i = 1; i <= 25; i++) {
  await hookgres.send({
    tenantId: "acme",
    eventType: "user.created",
    payload: { i },
  });
}

/** What your cron route (for example `/api/cron/webhooks`) would run. */
async function drainWebhooks(): Promise<number> {
  let total = 0;
  let processed: number;
  do {
    processed = await hookgres.runOnce(); // up to `concurrency` deliveries
    total += processed;
  } while (processed > 0);
  return total;
}

console.log(`cron run delivered ${await drainWebhooks()} webhooks`);
console.log(`receiver got ${receiver.received.length}`);
if (receiver.received.length !== 25) throw new Error("Expected 25 webhooks");

await pool.query("DROP SCHEMA hookgres_ex_serverless CASCADE");
await pool.end();
await receiver.close();
