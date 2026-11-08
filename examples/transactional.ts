/**
 * Transactional outbox: a webhook is queued only if your transaction commits.
 *
 *   docker compose up -d postgres && pnpm build && node examples/transactional.ts
 */
import { Hookgres } from "hookgres";
import pg from "pg";
import { databaseUrl, startReceiver } from "./receiver.ts";

const pool = new pg.Pool({ connectionString: databaseUrl });
const hookgres = new Hookgres({ pool, schema: "hookgres_ex_transactional" });
await pool.query("DROP SCHEMA IF EXISTS hookgres_ex_transactional CASCADE"); // a previous run may have crashed
await hookgres.migrate();
await pool.query(
  "CREATE TABLE IF NOT EXISTS hookgres_ex_transactional.invoices (id text PRIMARY KEY, status text NOT NULL)",
);

let secret = "";
const receiver = await startReceiver({ secret: () => secret });
const endpoint = await hookgres.createEndpoint({
  tenantId: "acme",
  url: receiver.url,
});
secret = endpoint.secret;
hookgres.start();

/** Marks an invoice paid and queues `invoice.paid` in the same transaction. */
async function markPaid(invoiceId: string, fail: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO hookgres_ex_transactional.invoices (id, status) VALUES ($1, 'paid')",
      [invoiceId],
    );
    await hookgres.send(
      { tenantId: "acme", eventType: "invoice.paid", payload: { invoiceId } },
      { client }, // same connection, same transaction
    );
    if (fail) throw new Error("Something failed after send()");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.log(`${invoiceId}: rolled back (${(error as Error).message})`);
  } finally {
    client.release();
  }
}

await markPaid("in_committed", false);
await markPaid("in_rolled_back", true);

await receiver.waitFor(1);
await new Promise((resolve) => setTimeout(resolve, 1_500)); // give a stray webhook time to show up
const ids = receiver.received.map(
  (r) => (r.event.data as { invoiceId: string }).invoiceId,
);
console.log("Webhooks received for:", ids);
if (ids.length !== 1 || ids[0] !== "in_committed") {
  throw new Error("Expected exactly one webhook, for the committed invoice");
}

await hookgres.stop();
await pool.query("DROP SCHEMA hookgres_ex_transactional CASCADE");
await pool.end();
await receiver.close();
