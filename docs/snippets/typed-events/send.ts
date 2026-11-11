import { HookgresValidationError } from "hookgres";
import type { AppHookgres } from "./hookgres.js";

export async function markInvoicePaid(
  hookgres: AppHookgres,
  tenantId: string,
  invoiceId: string,
  amount: number,
) {
  const client = await hookgres.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [
      invoiceId,
    ]);
    // Typed and validated: a wrong field fails to compile, and an invalid
    // value throws before anything is written.
    await hookgres.send(
      { tenantId, eventType: "invoice.paid", payload: { invoiceId, amount } },
      { client },
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof HookgresValidationError && error.issues) {
      // The message names the failing fields. `issues` has the details and
      // can quote payload values, so log it like a payload.
      console.warn(error.message, error.issues);
    }
    throw error;
  } finally {
    client.release();
  }
}
