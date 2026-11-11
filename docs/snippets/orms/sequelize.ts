import type { Sequelize, Transaction } from "sequelize";

/** Runs hookgres.send()'s SQL in a Sequelize transaction. */
export function fromSequelize(sequelize: Sequelize, transaction: Transaction) {
  return {
    async query(text: string, values: unknown[] = []) {
      const [results] = await sequelize.query(text, {
        bind: values,
        transaction,
        raw: true,
      });
      const rows = results as never[];
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
    },
  };
}
