import { pool } from "./db.js";

export async function payInvoice(invoiceId: string, tenantId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = $1 AND tenant_id = $2",
      [invoiceId, tenantId],
    );
    await client.query(
      "INSERT INTO ledger (tenant_id, invoice_id, kind) VALUES ($1, $2, 'payment')",
      [tenantId, invoiceId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
