// llms.txt (https://llmstxt.org) for AI coding agents, built from AGENTS.md
// and docs/. Used by build-site.mjs for hookgres.dev/llms.txt, and run
// directly (`node scripts/agent-docs.mjs`, on prepack) to write the llms.txt
// that ships in the npm package.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");
export const site = "https://hookgres.dev";
const docsDir = join(root, "docs");

// Numbered steps for an agent asked to "add Hookgres webhooks to this app".
// The landing page's one-line prompt points here, so keep them short and
// exact. AGENTS.md is the single source; edit them there.
export function agentInstructions() {
  const heading = "## Instructions for AI agents";
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const start = agents.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`AGENTS.md is missing "${heading}"`);
  const rest = agents.slice(start + 1);
  const end = rest.indexOf("\n## ", heading.length);
  const section = (end === -1 ? rest : rest.slice(0, end)).trim();
  return [...section.split("\n"), ""];
}

/** Docs pages (paths relative to docs/), in llms.txt order. */
export function docsPages() {
  return readdirSync(docsDir, { recursive: true })
    .map((file) => file.split("\\").join("/"))
    .filter(
      (file) =>
        file.endsWith(".md") &&
        !file.startsWith(".vitepress/") &&
        !file.startsWith("public/"),
    )
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

function order(file) {
  if (file === "index.md") return 0;
  if (file === "getting-started.md") return 1;
  if (file === "playground.md") return 2;
  if (file.startsWith("guides/")) return 3;
  if (file.startsWith("reference/")) return 4;
  return 5;
}

export function pageTitle(markdown, file) {
  return markdown.match(/^#\s+(.+)$/m)?.[1] ?? file;
}

/** Fails if the instructions link to a docs page that doesn't exist. */
export function checkInstructionLinks(pages) {
  const links = agentInstructions()
    .join("\n")
    .matchAll(/hookgres\.dev\/docs\/([\w/-]+\.md)/g);
  for (const [, file] of links) {
    if (!pages.includes(file)) {
      throw new Error(`AGENTS.md instructions link to missing docs/${file}`);
    }
  }
}

/** The llms.txt text, given `[{ file, title }]` for every docs page. */
export function llmsTxt(pages) {
  return [
    "# Hookgres",
    "",
    "> Hookgres is an MIT-licensed TypeScript library for sending signed webhooks to your customers from the Postgres you already run. `send()` can join your database transaction, so a webhook is queued only if your data commits. It has Standard Webhooks signatures, durable retries, endpoint health, secret rotation, replay and a delivery log. Install with `npm install hookgres pg`. Requires Node.js 22.12+ and Postgres 14+.",
    "",
    ...agentInstructions(),
    "## Docs",
    "",
    ...pages.map(({ file, title }) => `- [${title}](${site}/docs/${file})`),
    "",
    "## Optional",
    "",
    `- [Full documentation in one file](${site}/llms-full.txt)`,
    `- [Agent skill (SKILL.md)](${site}/SKILL.md)`,
    "- [Source code](https://github.com/NickolasBenakis/hookgres)",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const pages = docsPages();
  checkInstructionLinks(pages);
  const entries = pages.map((file) => ({
    file,
    title: pageTitle(readFileSync(join(docsDir, file), "utf8"), file),
  }));
  writeFileSync(join(root, "llms.txt"), llmsTxt(entries));
  console.log("Wrote llms.txt");
}
