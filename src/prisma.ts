import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "./types.js";

/**
 * The part of a Prisma transaction client `fromPrisma` uses. Any
 * `Prisma.TransactionClient` matches, including one from a client extended
 * with `$extends`.
 */
export interface PrismaTransactionClient {
  $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): PromiseLike<T>;
}

/**
 * Lets `hookgres.send()` run its query through a Prisma interactive
 * transaction, so the webhook is queued only if the transaction commits.
 * Pass the `tx` your `prisma.$transaction(async (tx) => ...)` callback
 * received, never `prisma` itself: `prisma` runs outside the transaction.
 * The array form of `$transaction` can't run it.
 *
 * Hookgres's query runs with `tx.$queryRawUnsafe()` on the transaction's
 * connection. That is safe here: the query text is fixed by Hookgres, and
 * the values are sent as bound parameters, never pasted into the SQL. Works
 * with any driver adapter that supports interactive transactions. Database
 * errors from `send()` reach you as Prisma errors (`P2010`).
 *
 * @example
 * import { fromPrisma } from "hookgres/prisma";
 *
 * await prisma.$transaction(async (tx) => {
 *   await tx.invoice.update({ where: { id }, data: { status: "paid" } });
 *   await hookgres.send(
 *     { tenantId, eventType: "invoice.paid", payload: { invoiceId: id } },
 *     { client: fromPrisma(tx) }, // queued only if the transaction commits
 *   );
 * });
 *
 * @see https://hookgres.dev/docs/guides/prisma
 */
export function fromPrisma(tx: PrismaTransactionClient): Queryable {
  return {
    async query<R extends QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      const rows = await tx.$queryRawUnsafe<R[]>(text, ...values);
      // send() only reads `rows`.
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
    },
  };
}
