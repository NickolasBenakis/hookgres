import { CompiledQuery, type Kysely } from "kysely";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "./types.js";

/**
 * Lets `hookgres.send()` run its query through a Kysely transaction, so the
 * webhook is queued only if the transaction commits. Pass the `trx` your
 * `db.transaction().execute()` callback received (or the one
 * `db.startTransaction()` returned), never `db` itself: `db` runs outside
 * the transaction.
 *
 * Hookgres's query runs with `CompiledQuery.raw()` on the transaction's
 * connection, with its values as bound parameters. It skips your plugins
 * (`withoutPlugins()`), so plugins such as `CamelCasePlugin` can't rename the
 * columns `send()` reads or the keys inside your payload. Needs Kysely's
 * `PostgresDialect`.
 *
 * @example
 * import { fromKysely } from "hookgres/kysely";
 *
 * await db.transaction().execute(async (trx) => {
 *   await trx.updateTable("invoices").set({ status: "paid" }).where("id", "=", id).execute();
 *   await hookgres.send(
 *     { tenantId, eventType: "invoice.paid", payload: { invoiceId: id } },
 *     { client: fromKysely(trx) }, // queued only if the transaction commits
 *   );
 * });
 *
 * @see https://hookgres.dev/docs/guides/kysely
 */
export function fromKysely(trx: {
  withoutPlugins(): Pick<Kysely<unknown>, "executeQuery">;
}): Queryable {
  return {
    async query<R extends QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      const { rows } = await trx
        .withoutPlugins()
        .executeQuery<R>(CompiledQuery.raw(text, values));
      // send() only reads `rows`.
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
    },
  };
}
