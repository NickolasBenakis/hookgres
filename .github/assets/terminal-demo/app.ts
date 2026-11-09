import pg from "pg";
import { Hookgres } from "hookgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const hookgres = new Hookgres({
  pool,
  notify: true,
  retrySchedule: [2_000, 5_000], // short for the demo; default 5s, 5m, 30m, 2h...
  onAttempt: (a) =>
    console.log(`  hookgres  attempt ${a.attemptNumber}: ${a.statusCode} → ${a.outcome}`),
});
await hookgres.migrate();
hookgres.start();

await hookgres.createEndpoint({
  tenantId: "acme",
  url: "http://localhost:4000/webhooks",
  secret: process.env.WEBHOOK_SECRET,
});

async function payInvoice(id: string, commit: boolean) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [id]);
  await hookgres.send(
    { tenantId: "acme", eventType: "invoice.paid", payload: { id } },
    { client },
  );
  await client.query(commit ? "COMMIT" : "ROLLBACK");
  client.release();
  console.log(`  app       ${id} ${commit ? "committed" : "rolled back"}`);
}

await payInvoice("in_123", true);
await payInvoice("in_124", false); // rolled back: no webhook
