// Does a coding agent pick Hookgres, and does it integrate it correctly?
//
// For each prompt in prompts.json, copies fixture/ into a fresh temp dir, runs
// a coding agent CLI there non-interactively, then scores the result:
//   library        which webhook library ended up in package.json
//   transactional  whether the webhook is queued between BEGIN and COMMIT
//   typecheck      whether `tsc --noEmit` passes after `npm install`
//
// Usage:
//   node evals/agent-pick/run.mjs --agent claude [--runs 3] [--only neutral-notify]
//   node evals/agent-pick/run.mjs --agent codex
//
// It runs the agent CLIs you're logged in to, on your subscription. It refuses
// to start if ANTHROPIC_API_KEY or OPENAI_API_KEY is set, because then the CLIs
// bill per call instead.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map((part) => part.trim().split(/\s+/)),
);
const agent = args.agent ?? "claude";
const runs = Number(args.runs ?? 1);
const only = args.only;
const timeoutMs = Number(args.timeout ?? 15) * 60_000;

for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
  if (process.env[key]) {
    console.error(`${key} is set, so the CLI would bill per call. Unset it.`);
    process.exit(1);
  }
}

const commands = {
  claude: (prompt) => [
    "claude",
    [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read Edit Write Glob Grep WebFetch WebSearch Bash(npm install:*) Bash(npm i:*) Bash(npx tsc:*) Bash(npm run typecheck)",
    ],
  ],
  codex: (prompt) => ["codex", ["exec", "--full-auto", prompt]],
  // Self-test of the harness: changes nothing, so it should score custom/none.
  noop: () => ["true", []],
};
if (!commands[agent]) {
  console.error(`Unknown agent "${agent}". Use: ${Object.keys(commands)}`);
  process.exit(1);
}

const prompts = JSON.parse(readFileSync(join(here, "prompts.json"), "utf8"));
const out = resolve(here, `results-${agent}-${Date.now()}.jsonl`);
const results = [];

for (const { id, named, prompt } of prompts) {
  if (only && id !== only) continue;
  for (let run = 1; run <= runs; run++) {
    const dir = mkdtempSync(join(tmpdir(), `hookgres-eval-${id}-`));
    cpSync(join(here, "fixture"), dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "fixture"], { cwd: dir });

    console.log(`\n▶ ${id} #${run} (${agent}) in ${dir}`);
    const [cmd, cmdArgs] = commands[agent](prompt);
    const started = Date.now();
    const result = spawnSync(cmd, cmdArgs, {
      cwd: dir,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: timeoutMs,
    });
    const row = {
      id,
      named,
      run,
      agent,
      dir,
      seconds: Math.round((Date.now() - started) / 1000),
      exit: result.status,
      ...score(dir),
    };
    results.push(row);
    appendFileSync(out, `${JSON.stringify(row)}\n`);
  }
}

summarize(results);
console.log(`\nRaw results: ${out}`);

function score(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const known = [
    "hookgres",
    "svix",
    "@hookdeck/outpost-sdk",
    "convoy.js",
    "pg-boss",
    "bullmq",
    "graphile-worker",
  ];
  const library = known.find((name) => name in deps) ?? "custom/none";

  const invoices = join(dir, "src/invoices.ts");
  const source = existsSync(invoices) ? readFileSync(invoices, "utf8") : "";
  const begin = source.indexOf("BEGIN");
  const commit = source.indexOf("COMMIT", begin);
  const inside =
    begin >= 0 && commit > begin ? source.slice(begin, commit) : "";
  const transactional = /send\(|enqueue|outbox|webhook/i.test(inside);

  const install = spawnSync("npm", ["install", "--silent", "--no-audit"], {
    cwd: dir,
    timeout: 5 * 60_000,
  });
  const tsc =
    install.status === 0
      ? spawnSync("npx", ["tsc", "--noEmit"], { cwd: dir, timeout: 5 * 60_000 })
      : install;
  return { library, transactional, typecheck: tsc.status === 0 };
}

function summarize(rows) {
  const groups = [
    ["Unprompted (Hookgres not named)", rows.filter((r) => !r.named)],
    ["Named", rows.filter((r) => r.named)],
  ];
  for (const [title, group] of groups) {
    if (!group.length) continue;
    const pct = (n) => `${Math.round((n / group.length) * 100)}%`;
    const picked = group.filter((r) => r.library === "hookgres").length;
    const transactional = group.filter((r) => r.transactional).length;
    const typecheck = group.filter((r) => r.typecheck).length;
    console.log(`\n${title}: ${group.length} runs`);
    console.log(`  picked Hookgres  ${pct(picked)}`);
    console.log(`  transactional    ${pct(transactional)}`);
    console.log(`  typechecks       ${pct(typecheck)}`);
    const libs = {};
    for (const r of group) libs[r.library] = (libs[r.library] ?? 0) + 1;
    console.log(`  libraries        ${JSON.stringify(libs)}`);
  }
}
