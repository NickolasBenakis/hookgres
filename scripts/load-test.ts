// Load test: N messages, several competing workers, one local receiver.
// Fails if any webhook is lost or delivered twice.
//
//   pnpm bench                 (starts Postgres in Docker)
//   LOAD_N=50000 DATABASE_URL=... pnpm bench
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { Hookgres } from "../dist/index.js";

const N = Number(process.env.LOAD_N ?? 20_000);
const WORKERS = Number(process.env.LOAD_WORKERS ?? 4);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);

const container = process.env.DATABASE_URL
  ? undefined
  : await new PostgreSqlContainer("postgres:16-alpine").start();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? container?.getConnectionUri(),
  max: WORKERS * 4 + 10,
});

const seen = new Map<string, number>();
const server = createServer((req, res) => {
  const id = String(req.headers["webhook-id"]);
  seen.set(id, (seen.get(id) ?? 0) + 1);
  req.resume();
  req.on("end", () => res.writeHead(204).end());
});
server.keepAliveTimeout = 60_000;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const options = {
  pool,
  schema: "hookgres_load",
  concurrency: CONCURRENCY,
  pollIntervalMs: 100,
  onError: (error: unknown) => console.error(error),
};
const workers = Array.from({ length: WORKERS }, () => new Hookgres(options));
const [hg] = workers;
if (!hg) throw new Error("no workers");
await pool.query("DROP SCHEMA IF EXISTS hookgres_load CASCADE");
await hg.migrate();
await hg.createEndpoint({
  tenantId: "load",
  url: `http://127.0.0.1:${port}/hook`,
});

let started = performance.now();
const BATCH = 200;
for (let i = 0; i < N; i += BATCH) {
  await Promise.all(
    Array.from({ length: Math.min(BATCH, N - i) }, (_, j) =>
      hg.send({
        tenantId: "load",
        eventType: "load.test",
        payload: { i: i + j },
      }),
    ),
  );
}
const sendSeconds = (performance.now() - started) / 1000;

started = performance.now();
for (const worker of workers) worker.start();
const deadline = Date.now() + 10 * 60_000;
while (seen.size < N && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const deliverSeconds = (performance.now() - started) / 1000;
await new Promise((resolve) => setTimeout(resolve, 500)); // catch stragglers
await Promise.all(workers.map((worker) => worker.stop()));

const { rows } = await pool.query<{ status: string; n: number }>(
  "SELECT status, count(*)::int AS n FROM hookgres_load.deliveries GROUP BY status",
);
const duplicates = [...seen.values()].filter((n) => n > 1).length;
const succeeded = rows.find((r) => r.status === "succeeded")?.n ?? 0;

console.log(
  JSON.stringify(
    {
      messages: N,
      workers: WORKERS,
      concurrencyPerWorker: CONCURRENCY,
      sendPerSecond: Math.round(N / sendSeconds),
      deliveredPerSecond: Math.round(seen.size / deliverSeconds),
      received: seen.size,
      duplicates,
      statuses: Object.fromEntries(rows.map((r) => [r.status, r.n])),
    },
    null,
    2,
  ),
);

await pool.query("DROP SCHEMA hookgres_load CASCADE");
await pool.end();
server.close();
await container?.stop();

if (seen.size !== N || duplicates > 0 || succeeded !== N) {
  console.error("Load test FAILED");
  process.exit(1);
}
console.log("Load test passed");
