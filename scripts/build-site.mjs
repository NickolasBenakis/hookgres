// Builds the deployable hookgres.dev site into .site-dist/:
//   /         the static landing page from site/
//   /docs/    the VitePress docs from docs/
//   /docs/*.md, /llms.txt, /llms-full.txt   raw markdown for AI agents
// Deployed on Vercel; see vercel.json (build command and output directory).
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, ".site-dist");

rmSync(out, { recursive: true, force: true });
execFileSync("pnpm", ["exec", "vitepress", "build", "docs"], {
  cwd: root,
  stdio: "inherit",
});
cpSync(join(root, "site"), out, { recursive: true });
cpSync(join(root, "docs/.vitepress/dist"), join(out, "docs"), {
  recursive: true,
});

// Point crawlers at the docs sitemap as well as the landing page's.
const robots = join(out, "robots.txt");
const docsSitemap = "Sitemap: https://hookgres.dev/docs/sitemap.xml";
if (existsSync(robots) && !readFileSync(robots, "utf8").includes(docsSitemap)) {
  writeFileSync(
    robots,
    `${readFileSync(robots, "utf8").trimEnd()}\n${docsSitemap}\n`,
  );
}
// Raw markdown for AI agents: every page at /docs/<page>.md, an index at
// /llms.txt (https://llmstxt.org) and everything in one file at /llms-full.txt.
const docsDir = join(root, "docs");
const pages = readdirSync(docsDir, { recursive: true })
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.split("\\").join("/"))
  .sort((a, b) => order(a) - order(b) || a.localeCompare(b));
function order(file) {
  if (file === "index.md") return 0;
  if (file === "getting-started.md") return 1;
  if (file === "playground.md") return 2;
  if (file.startsWith("guides/")) return 3;
  if (file.startsWith("reference/")) return 4;
  return 5;
}
const site = "https://hookgres.dev";
const index = [
  "# Hookgres",
  "",
  "> Hookgres is an MIT-licensed TypeScript library for sending signed webhooks to your customers from the Postgres you already run: Standard Webhooks signatures, durable retries, endpoint health, secret rotation, replay and a delivery log. Install with `npm install hookgres pg`. Requires Node.js 22.12+ and Postgres 14+.",
  "",
  "## Docs",
  "",
];
const full = [];
for (const file of pages) {
  const markdown = readFileSync(join(docsDir, file), "utf8");
  const target = join(out, "docs", file === "index.md" ? "index.md" : file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, markdown);
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? file;
  index.push(`- [${title}](${site}/docs/${file})`);
  full.push(`<!-- ${site}/docs/${file} -->\n\n${markdown.trim()}\n`);
}
index.push(
  "",
  "## Optional",
  "",
  `- [Full documentation in one file](${site}/llms-full.txt)`,
  "- [Source code](https://github.com/NickolasBenakis/hookgres)",
  "",
);
writeFileSync(join(out, "llms.txt"), index.join("\n"));
writeFileSync(join(out, "llms-full.txt"), full.join("\n---\n\n"));

console.log(`Site built in ${out}`);
