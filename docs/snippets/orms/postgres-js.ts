import type { TransactionSql } from "postgres";

/** Runs hookgres.send()'s SQL in a postgres.js transaction (`sql.begin`). */
export function fromPostgresJs(tx: TransactionSql) {
  return {
    async query(text: string, values: unknown[] = []) {
      // Send strings as text (oid 25). Otherwise postgres.js JSON-encodes the
      // payload, which Hookgres has already encoded, a second time for jsonb.
      const params = values.map((v) =>
        typeof v === "string" ? tx.typed(v, 25) : v,
      );
      const rows = [...(await tx.unsafe(text, params as never[]))] as never[];
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
    },
  };
}
