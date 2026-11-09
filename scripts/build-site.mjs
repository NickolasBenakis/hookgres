// Builds the deployable hookgres.dev site into .site-dist/:
//   /         the static landing page from site/
//   /docs/    the VitePress docs from docs/
//   /docs/*.md, /llms.txt, /llms-full.txt   raw markdown for AI agents
//   /search-index.json                     sections for the landing page's search
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

// docs/.vitepress/config.ts swaps VitePress's search box for our palette via an
// alias on an internal file name. Fail loudly if an upgrade breaks the swap.
const docsAssets = join(out, "docs", "assets");
const hasPalette = readdirSync(docsAssets, { recursive: true }).some(
  (file) =>
    String(file).endsWith(".js") &&
    readFileSync(join(docsAssets, String(file)), "utf8").includes("hg-search"),
);
if (!hasPalette) {
  throw new Error("Docs search palette is missing from the VitePress build");
}

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
  .map((file) => file.split("\\").join("/"))
  .filter(
    (file) =>
      file.endsWith(".md") &&
      !file.startsWith(".vitepress/") &&
      !file.startsWith("public/"),
  )
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
  "> Hookgres is an MIT-licensed TypeScript library for sending signed webhooks to your customers from the Postgres you already run. `send()` can join your database transaction, so a webhook is queued only if your data commits. It has Standard Webhooks signatures, durable retries, endpoint health, secret rotation, replay and a delivery log. Install with `npm install hookgres pg`. Requires Node.js 22.12+ and Postgres 14+.",
  "",
  ...agentInstructions(),
  "## Docs",
  "",
];
const full = [];
for (const file of pages) {
  // Docs link to /guides/... relative to the VitePress base; make them absolute.
  const markdown = readFileSync(join(docsDir, file), "utf8")
    .replace(/\]\(\/(?!\/)/g, `](${site}/docs/`)
    // The docs home renders this Vue component; agents get the same content.
    .replace(
      "<DocsHub />",
      [
        "Ask your AI agent: `Add Hookgres webhooks to this app: hookgres.dev/llms.txt`",
        "",
        "Or install it yourself: `npm install hookgres pg`",
        "",
        `- [Getting started](${site}/docs/getting-started.md)`,
        `- [Playground](${site}/docs/playground.md)`,
        `- [llms.txt](${site}/llms.txt)`,
      ].join("\n"),
    );
  const target = join(out, "docs", file === "index.md" ? "index.md" : file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, markdown);
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? file;
  index.push(`- [${title}](${site}/docs/${file})`);
  full.push(`<!-- ${site}/docs/${file} -->\n\n${markdown.trim()}\n`);
}
const agentLinks = agentInstructions()
  .join("\n")
  .matchAll(/hookgres\.dev\/docs\/([\w/-]+\.md)/g);
for (const [, file] of agentLinks) {
  if (!pages.includes(file)) {
    throw new Error(`llms.txt instructions link to missing docs/${file}`);
  }
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

const searchIndex = JSON.stringify(buildSearchIndex());
if (searchIndex.length > 150 * 1024) {
  throw new Error(
    `search-index.json is ${searchIndex.length} bytes; trim it below 150 KB`,
  );
}
writeFileSync(join(out, "search-index.json"), searchIndex);

console.log(
  `Site built in ${out} (search-index.json ${(searchIndex.length / 1024).toFixed(1)} KB)`,
);

// Numbered steps for an agent asked to "add Hookgres webhooks to this app".
// The landing page's one-line prompt points here, so keep it short and exact.
function agentInstructions() {
  const doc = (file) => `${site}/docs/${file}`;
  return [
    "## Instructions for AI agents",
    "",
    "To add Hookgres webhooks to an existing app:",
    "",
    '1. Install `hookgres` and `pg` (`npm install hookgres pg`). Create one instance from the app\'s existing pool: `const hookgres = new Hookgres({ pool })`, with `import { Hookgres } from "hookgres"`.',
    "2. Call `await hookgres.migrate()` on startup. It is idempotent and takes an advisory lock. If the app's database role can't `CREATE`, run it from a deploy step instead.",
    `3. Start the worker in a long-running process with \`hookgres.start()\`. On \`SIGTERM\`, \`await hookgres.stop()\` before \`pool.end()\` so in-flight requests finish. On serverless, call \`await hookgres.runOnce()\` from a cron route and never \`start()\`. See ${doc("guides/workers.md")}.`,
    `4. Call \`hookgres.send({ tenantId, eventType, payload }, { client })\` inside the database transaction that makes the change, passing that transaction's client, so the webhook is queued only if it commits. Add \`idempotencyKey\` when a send can repeat. See ${doc("guides/sending.md")}.`,
    `5. Add endpoint management routes scoped to the signed-in tenant: \`createEndpoint({ tenantId, url, eventTypes })\` (return \`endpoint.secret\` once), \`listEndpoints(tenantId)\`, \`updateEndpoint(id, patch)\`, \`deleteEndpoint(id)\` and \`rotateEndpointSecret(id)\`. Take \`tenantId\` from the session, never the request body, and before updating, deleting or rotating by id, load it with \`getEndpoint(id)\` and check that \`endpoint.tenantId\` matches. See ${doc("guides/endpoints.md")}.`,
    `6. Pass \`blockPrivateAddresses: true\` to \`new Hookgres({ pool, blockPrivateAddresses: true })\`, so customer endpoint URLs can't reach private or internal addresses. Hookgres checks them when an endpoint is created and again after DNS on every delivery. See ${doc("guides/production.md")}.`,
    `7. Pass \`onError\` to the app's logger. Receivers verify with \`verifyWebhook({ secret, headers, body })\` on the raw body and deduplicate on \`webhook-id\`. See ${doc("guides/verifying.md")} and ${doc("reference/api.md")}.`,
    "",
  ];
}

// One entry per page and per h2/h3, for site/search.js. Anchor ids come from
// the built VitePress HTML, so they always match what the docs actually serve.
function buildSearchIndex() {
  const index = { pages: [], sections: [] };
  for (const file of pages) {
    const path = file.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
    const url = `/docs/${path}`;
    const html = readFileSync(
      join(root, "docs/.vitepress/dist", file.replace(/\.md$/, ".html")),
      "utf8",
    );
    const ids = [...html.matchAll(/<h([23]) id="([^"]+)" tabindex="-1">/g)].map(
      ([, level, id]) => ({ level: Number(level), id }),
    );
    const parts = splitSections(readFileSync(join(docsDir, file), "utf8"));
    const headed = parts.filter((part) => part.level > 1);
    if (
      headed.length !== ids.length ||
      headed.some((part, i) => part.level !== ids[i].level)
    ) {
      throw new Error(
        `search index: headings in docs/${file} don't match the built HTML`,
      );
    }
    const page = index.pages.push({ t: parts[0].heading || path }) - 1;
    let parent = "";
    let next = 0;
    for (const part of parts) {
      const entry = { p: page, h: "", u: url, b: part.text };
      if (part.level > 1) {
        const { id } = ids[next++];
        if (part.level === 2) parent = part.heading;
        entry.h = part.heading;
        entry.u = `${url}#${id}`;
        if (part.level === 3) entry.ph = parent;
      }
      if (part.code.length) entry.k = part.code.join(" ");
      index.sections.push(entry);
    }
  }
  const links = index.pages.push({ t: "hookgres.dev" }) - 1;
  for (const [h, u, b] of [
    [
      "Get started",
      "/docs/getting-started",
      "Install hookgres and pg, create the tables, start a worker and send your first webhook.",
    ],
    [
      "Playground",
      "/docs/playground",
      "Run the playground app locally: send events, break endpoints, watch retries and replay.",
    ],
    [
      "llms.txt",
      "/llms.txt",
      "Instructions and a docs index for AI coding agents. Prompt: Add Hookgres webhooks to this app: hookgres.dev/llms.txt",
    ],
    [
      "llms-full.txt",
      "/llms-full.txt",
      "Every docs page in one markdown file, for AI agents and LLM context.",
    ],
    [
      "GitHub",
      "https://github.com/NickolasBenakis/hookgres",
      "Source code, issues and examples. MIT licensed.",
    ],
    [
      "npm",
      "https://www.npmjs.com/package/hookgres",
      "The hookgres package on npm. npm install hookgres pg",
    ],
  ]) {
    index.sections.push({ p: links, h, u, b });
  }
  return index;
}

// Splits a docs page into its intro and one part per heading, as plain text.
// Code blocks are dropped; their identifiers (runOnce, pollIntervalMs,
// webhook_id) are kept as search keywords.
function splitSections(markdown) {
  const parts = [{ level: 1, heading: "", lines: [], code: new Set() }];
  let fence = null;
  for (const line of markdown
    .replace(/\r\n/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")) {
    const part = parts.at(-1);
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      // Only a bare run of at least as many fence characters closes a block.
      if (marker?.[1].startsWith(fence) && !marker[2].trim()) fence = null;
      else
        for (const [word] of line.matchAll(
          /\b[a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/g,
        ))
          part.code.add(word);
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (heading) {
      const text = plain(heading[2].replace(/\s*\{#[^}]+\}$/, ""));
      if (heading[1].length === 1) {
        if (parts.length > 1) {
          throw new Error(`search index: a second h1 "${text}" in a docs page`);
        }
        part.heading = text;
      } else
        parts.push({
          level: heading[1].length,
          heading: text,
          lines: [],
          code: new Set(),
        });
      continue;
    }
    if (/^\s*:::/.test(line) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line))
      continue;
    part.lines.push(plain(line.replace(/^\s*(?:[-*+]|\d+\.|>)\s+/, "")));
  }
  return parts.map(({ level, heading, lines, code }) => {
    const text = lines.join(" ").replace(/\s+/g, " ").trim();
    return {
      level,
      heading,
      text,
      code: [...code].filter((word) => !text.includes(word)).slice(0, 16),
    };
  });
}

// Markdown inline syntax to text. Code spans are kept verbatim, so
// `Promise<void>` and `webhook_id` survive the tag and emphasis stripping.
function plain(markdown) {
  return markdown
    .split(/(`[^`]*`)/)
    .map((chunk, i) =>
      i % 2
        ? chunk.slice(1, -1).replaceAll("\\|", "|")
        : chunk
            .replace(/<[^>]+>/g, "")
            .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
            .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/\*\*|(?<!\w)_|_(?!\w)|(?<![\s*])\*|\*(?![\s*])/g, "")
            .replace(/\s*\|\s*/g, " "),
    )
    .join("")
    .trim();
}
