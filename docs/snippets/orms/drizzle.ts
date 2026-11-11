import { type SQL, sql } from "drizzle-orm";

/** Runs hookgres.send()'s SQL in a Drizzle transaction (node-postgres or postgres.js). */
export function fromDrizzle(tx: { execute(query: SQL): PromiseLike<unknown> }) {
  return {
    async query(text: string, values: unknown[] = []) {
      // Rebuild "... $1 ..." as Drizzle SQL with bound parameters.
      const chunks = text
        .split(/\$(\d+)/)
        .map((part, i) =>
          i % 2 ? sql`${values[Number(part) - 1]}` : sql.raw(part),
        );
      const result = await tx.execute(sql.join(chunks));
      // node-postgres returns { rows }; postgres.js returns the rows themselves.
      const rows = Array.isArray(result)
        ? result
        : (result as { rows: never[] }).rows;
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
    },
  };
}
