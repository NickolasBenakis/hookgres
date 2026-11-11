import type { SqlEntityManager } from "@mikro-orm/postgresql";
import { fromKysely } from "hookgres/kysely";

/** Runs hookgres.send()'s SQL in a MikroORM 7 transaction (`em.transactional`). */
export function fromMikroORM(em: SqlEntityManager) {
  // Inside em.transactional(), getKysely() is bound to the transaction.
  return fromKysely(em.getKysely());
}
