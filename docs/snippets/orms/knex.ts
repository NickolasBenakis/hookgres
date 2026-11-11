import type { Knex } from "knex";

/** Runs hookgres.send()'s SQL in a Knex transaction (`knex.transaction`). */
export function fromKnex(trx: Knex.Transaction) {
  return {
    async query(text: string, values: unknown[] = []) {
      // Knex binds "?" placeholders: turn each $n into ? and order the values to match.
      const bindings: unknown[] = [];
      const knexText = text
        .replaceAll("?", "\\?")
        .replace(/\$(\d+)/g, (_, n) => {
          bindings.push(values[Number(n) - 1]);
          return "?";
        });
      const { rows } = await trx.raw(knexText, bindings as Knex.ValueDict[]);
      return {
        rows: rows as never[],
        rowCount: rows.length,
        command: "",
        oid: 0,
        fields: [],
      };
    },
  };
}
