// Packs the library, installs the tarball into a blank project, and checks
// that it imports (ESM and require), typechecks, and delivers a webhook.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const root = resolve(import.meta.dirname, "..");
const run = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

const dir = mkdtempSync(join(tmpdir(), "hookgres-smoke-"));
let container;
try {
  run("pnpm", ["build"], root);
  run("npm", ["pack", "--pack-destination", dir], root);
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "smoke", private: true, type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      `./${tarball}`,
      "pg",
      "@types/pg",
      "@types/node",
      "typescript",
    ],
    dir,
  );

  cpSync(join(root, "examples/basic.ts"), join(dir, "demo.ts"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        types: ["node"],
      },
      include: ["demo.ts"],
    }),
  );
  run("npx", ["tsc", "-p", "."], dir);
  run(
    "node",
    [
      "--input-type=commonjs",
      "-e",
      "const h = require('hookgres'); const p = require('hookgres/prisma'); if (typeof h.Hookgres !== 'function' || typeof p.fromPrisma !== 'function') process.exit(1); console.log('require() ok')",
    ],
    dir,
  );

  let databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    databaseUrl = container.getConnectionUri();
  }
  run("node", ["demo.ts"], dir, { DATABASE_URL: databaseUrl });
  console.log("Smoke test passed");
} finally {
  await container?.stop();
  rmSync(dir, { recursive: true, force: true });
}
