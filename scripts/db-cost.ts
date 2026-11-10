// Database cost: what Hookgres costs your Postgres per webhook, and what an
// idle worker costs per minute. Prints JSON; docs/guides/database-cost.md
// quotes the numbers.
//
//   pnpm db-cost               (starts Postgres in Docker)
//   COST_N=50000 COST_IDLE_SECONDS=120 DATABASE_URL=... pnpm db-cost
//
// Per webhook: 1 endpoint, a ~200-byte payload, a successful delivery. It
// counts statements on the client side, reads WAL from pg_current_wal_lsn(),
// and table sizes from pg_total_relation_size(). Run it on an otherwise idle
// server: WAL from other sessions and autovacuum would be counted too.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpus, platform, totalmem } from "node:os";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { Hookgres } from "../dist/index.js";

const N = Number(process.env.COST_N ?? 10_000);
const IDLE_SECONDS = Number(process.env.COST_IDLE_SECONDS ?? 60);
const SCHEMA = "hookgres_cost";

const container = process.env.DATABASE_URL
  ? undefined
  : await new PostgreSqlContainer("postgres:18-alpine").start();
const connectionString =
  process.env.DATABASE_URL ?? container?.getConnectionUri();

// Every statement Hookgres runs goes through Client#query, including the
// ones pool.query() runs for it.
let statements = 0;
class CountingClient extends pg.Client {
  // biome-ignore lint/suspicious/noExplicitAny: forwards every overload
  query(...args: any[]): any {
    statements++;
    // biome-ignore lint/suspicious/noExplicitAny: forwards every overload
    return (super.query as any).apply(this, args);
  }
}
const pool = new pg.Pool({ connectionString, Client: CountingClient, max: 20 });
// Measurements go through their own pool, so they aren't counted.
const meter = new pg.Pool({ connectionString, max: 2 });

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => res.writeHead(204).end());
});
server.keepAliveTimeout = 60_000;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const options = { pool, schema: SCHEMA, onError: console.error };
const hookgres = new Hookgres(options);
await meter.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await hookgres.migrate();
await hookgres.createEndpoint({
  tenantId: "cost",
  url: `http://127.0.0.1:${port}/hook`,
});

const tables = ["messages", "deliveries", "attempts"] as const;
async function sizes(): Promise<Record<string, number>> {
  const { rows } = await meter.query<{ t: string; bytes: string }>(
    `SELECT t, pg_total_relation_size(format('%I.%I', $1::text, t)) AS bytes
     FROM unnest($2::text[]) AS t`,
    [SCHEMA, tables],
  );
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.bytes)]));
}
async function lsn(): Promise<string> {
  const { rows } = await meter.query<{ lsn: string }>(
    "SELECT pg_current_wal_lsn() AS lsn",
  );
  return rows[0]?.lsn ?? "0/0";
}
async function walSince(start: string): Promise<number> {
  const { rows } = await meter.query<{ bytes: string }>(
    "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1) AS bytes",
    [start],
  );
  return Number(rows[0]?.bytes ?? 0);
}
async function succeeded(): Promise<number> {
  const { rows } = await meter.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.deliveries WHERE status = 'succeeded'`,
  );
  return rows[0]?.n ?? 0;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A realistic event of about 200 bytes once serialized.
function payload(i: number) {
  return {
    id: `inv_${String(i).padStart(10, "0")}`,
    object: "invoice",
    status: "paid",
    customer: "cus_8f3a2b1c9d7e",
    amount: 4200,
    currency: "eur",
    lines: [{ sku: "plan_pro_monthly", quantity: 1 }],
    paidAt: "2026-11-10T12:00:00.000Z",
  };
}
const payloadBytes = JSON.stringify(payload(0)).length;

// Sends N webhooks, 50 at a time, then one worker with default options
// delivers them. Returns per-webhook statements, WAL and table growth.
async function measureRound(offset: number) {
  const before = await sizes();
  statements = 0;
  let start = await lsn();
  for (let i = 0; i < N; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, N - i) }, (_, j) =>
        hookgres.send({
          tenantId: "cost",
          eventType: "invoice.paid",
          payload: payload(offset + i + j),
        }),
      ),
    );
  }
  const send = {
    statements: statements / N,
    walBytes: (await walSince(start)) / N,
  };

  statements = 0;
  start = await lsn();
  hookgres.start();
  while ((await succeeded()) < offset + N) await wait(50);
  await hookgres.stop();
  const deliver = {
    statements: statements / N,
    walBytes: (await walSince(start)) / N,
  };

  const after = await sizes();
  const bytes = Object.fromEntries(
    tables.map((t) => [
      t,
      Math.round(((after[t] ?? 0) - (before[t] ?? 0)) / N),
    ]),
  );
  return { send, deliver, bytes };
}
async function vacuum() {
  await meter.query(`VACUUM ${tables.map((t) => `${SCHEMA}.${t}`).join(", ")}`);
}

// Round 1 starts from empty tables. Each delivery row is written three times
// (insert, claim, result), so the tables also hold dead row versions. Round 2
// runs after a VACUUM, which lets new rows reuse that space, as autovacuum
// does in a long-running database: its growth is the steady-state size.
const first = await measureRound(0);
await vacuum();
const steady = await measureRound(N);
const { send, deliver } = steady;
const bytesPerWebhook = steady.bytes;
const bytesPerWebhookFromEmpty = first.bytes;

// Idle: an empty queue, default 1s poll, with and without notify. Database-
// wide WAL would also count autovacuum and other sessions, so this counts the
// rows written to Hookgres's tables instead (pg_stat_user_tables, which
// idle backends flush within 10 seconds).
async function rowsWritten(): Promise<number> {
  const { rows } = await meter.query<{ n: string }>(
    `SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) AS n
     FROM pg_stat_user_tables WHERE schemaname = $1`,
    [SCHEMA],
  );
  return Number(rows[0]?.n ?? 0);
}
async function idle(notify: boolean) {
  const worker = new Hookgres({ ...options, notify });
  await wait(12_000);
  const rowsBefore = await rowsWritten();
  statements = 0;
  worker.start();
  await wait(IDLE_SECONDS * 1000);
  await worker.stop();
  const statementsPerMinute = Math.round((statements * 60) / IDLE_SECONDS);
  await wait(12_000);
  return {
    statementsPerMinute,
    rowsWritten: (await rowsWritten()) - rowsBefore,
  };
}
const idleWorker = await idle(false);
const idleWorkerNotify = await idle(true);

const { rows: version } = await meter.query<{ v: string }>(
  "SELECT current_setting('server_version') AS v",
);
const round = (n: number) => Math.round(n * 100) / 100;
console.log(
  JSON.stringify(
    {
      machine: `${cpus()[0]?.model ?? "unknown CPU"}, ${Math.round(totalmem() / 2 ** 30)} GB, ${platform()}`,
      postgres: version[0]?.v,
      webhooks: N,
      payloadBytes,
      perWebhook: {
        statements: {
          send: round(send.statements),
          deliver: round(deliver.statements),
          total: round(send.statements + deliver.statements),
        },
        walBytes: {
          send: Math.round(send.walBytes),
          deliver: Math.round(deliver.walBytes),
          total: Math.round(send.walBytes + deliver.walBytes),
        },
        tableAndIndexBytes: {
          ...bytesPerWebhook,
          total: Object.values(bytesPerWebhook).reduce((a, b) => a + b, 0),
        },
        tableAndIndexBytesFromEmpty: {
          ...bytesPerWebhookFromEmpty,
          total: Object.values(bytesPerWebhookFromEmpty).reduce(
            (a, b) => a + b,
            0,
          ),
        },
      },
      idleSeconds: IDLE_SECONDS,
      idleWorker,
      idleWorkerNotify,
    },
    null,
    2,
  ),
);

await meter.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
await pool.end();
await meter.end();
server.close();
await container?.stop();
