import pg from "pg";
import { queue } from "./queue.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function payInvoice(id: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [id]);
    await queue.add("invoice.paid", { id });
    await client.query("INSERT INTO ledger (invoice_id) VALUES ($1)", [id]);
    await client.query("COMMIT");
    console.log(`  app       ${id} committed`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.log(`  app       ${id} rolled back: ${error.message}`);
  } finally {
    client.release();
  }
}

await payInvoice("in_123");
await payInvoice("in_124"); // already in the ledger, so the INSERT fails
