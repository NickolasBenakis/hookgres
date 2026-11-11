import type { QueryRunner } from "typeorm";

/** Runs hookgres.send()'s SQL on a TypeORM query runner inside a transaction. */
export function fromTypeORM(queryRunner: QueryRunner) {
  return {
    async query(text: string, values: unknown[] = []) {
      const { records } = await queryRunner.query(text, values, true);
      const rows = records as never[];
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
    },
  };
}
