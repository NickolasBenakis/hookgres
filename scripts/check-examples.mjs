// Runs every example against DATABASE_URL (default: the docker compose
// Postgres) and fails if any of them throws. Then boots the playground and
// checks that an event reaches all three of its receivers as expected.
// Expects `pnpm build` to have run.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";

const root = resolve(import.meta.dirname, "..");
const examples = [
  "basic.ts",
  "transactional.ts",
  "retries-and-replay.ts",
  "serverless.ts",
  "secret-rotation.ts",
];

function run(file, env = {}) {
  const child = spawn(process.execPath, [file], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${file} timed out`));
    }, 60_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGTERM") resolve();
      else reject(new Error(`${file} exited with ${code ?? signal}`));
    });
  });
  return { child, done };
}

for (const example of examples) {
  console.log(`\n▶ examples/${example}`);
  await run(`examples/${example}`).done;
}

console.log("\n▶ examples/playground/server.ts");
const port = 3917;
// Its own schema, so it never touches a playground running in docker compose.
const playground = run("examples/playground/server.ts", {
  PORT: String(port),
  PLAYGROUND_SCHEMA: "hookgres_playground_check",
});
const base = `http://127.0.0.1:${port}`;
const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return res.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; ; i++) {
    try {
      await api("GET", "/api/state");
      break;
    } catch (error) {
      if (i > 50) throw error;
      await sleep(200);
    }
  }
  await api("POST", "/api/reset");
  const sent = await api("POST", "/api/send", {
    eventType: "invoice.paid",
    payload: { check: true },
  });
  if (sent.deliveryCount !== 3) throw new Error("Expected 3 deliveries");

  const want = { healthy: "succeeded", flaky: "succeeded", down: "failed" };
  let state;
  for (let i = 0; i < 120; i++) {
    state = await api("GET", "/api/state");
    const got = Object.fromEntries(
      state.deliveries.map((d) => [d.endpoint, d.status]),
    );
    if (Object.entries(want).every(([k, v]) => got[k] === v)) break;
    await sleep(250);
  }
  const got = Object.fromEntries(
    state.deliveries.map((d) => [d.endpoint, `${d.status}/${d.attemptCount}`]),
  );
  console.log("playground deliveries:", got);
  if (
    got.healthy !== "succeeded/1" ||
    got.flaky !== "succeeded/3" ||
    got.down !== "failed/4"
  ) {
    throw new Error("Playground deliveries did not reach the expected states");
  }
  if (!state.received.every((r) => r.verified)) {
    throw new Error("A playground receiver rejected a signature");
  }
} finally {
  playground.child.kill("SIGTERM");
  await playground.done;
  const pool = new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/postgres",
  });
  await pool.query("DROP SCHEMA IF EXISTS hookgres_playground_check CASCADE");
  await pool.end();
}
console.log("\nAll examples passed.");
