// Hookgres on the same Postgres, with a worker in this process.
import pg from "pg";
import { Hookgres } from "hookgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const hookgres = new Hookgres({ pool, notify: true });
await hookgres.migrate();
hookgres.start();

await hookgres.createEndpoint({
  tenantId: "acme",
  url: "http://localhost:4000/webhooks",
  secret: process.env.WEBHOOK_SECRET,
});
