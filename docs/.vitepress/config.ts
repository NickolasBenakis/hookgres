import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { codeTheme } from "./code-theme";

const repo = "https://github.com/NickolasBenakis/hookgres";

// theme/SearchPalette.vue replaces VitePress's local search box. It loads the
// index with MiniSearch, resolved from VitePress's own install so it doesn't
// become a direct dependency.
const vitepressRequire = createRequire(
  createRequire(import.meta.url).resolve("vitepress"),
);
const minisearchEntry = vitepressRequire.resolve("minisearch");
const minisearch = minisearchEntry.slice(
  0,
  minisearchEntry.lastIndexOf("minisearch") + "minisearch".length,
);

// VitePress marks the current sidebar link only after hydration, so on first
// paint nothing is highlighted. This rule highlights it in the prerendered
// HTML; the theme adds html.hg-ready once VitePress has taken over.
function currentLinkStyle(relativePath: string) {
  const path = relativePath
    .replace(/(^|\/)index\.md$/, "$1")
    .replace(/\.md$/, "");
  const item = `html:not(.hg-ready) .VPSidebar .VPSidebarItem.is-link:has(> .item > a.link[href="/docs/${path}"])`;
  return `${item} > .item{background-color:var(--vp-c-brand-soft)}${item} > .item .text{color:var(--vp-c-brand-1)}`;
}

// The first prose paragraph of a docs page, as plain text of at most 160 chars.
function firstParagraph(relativePath: string): string | undefined {
  const file = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
  if (!existsSync(file)) return undefined;
  const blocks = readFileSync(file, "utf8").split(/\n\s*\n/);
  const block = blocks
    .map((b) => b.trim())
    .find(
      (b) =>
        /^[A-Za-z`*[]/.test(b) &&
        !b.startsWith("```") &&
        !b.startsWith(":::") &&
        !b.startsWith("|"),
    );
  if (!block) return undefined;
  const text = block
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= 160) return text;
  return `${text.slice(0, 157).replace(/\s+\S*$/, "")}…`;
}

export default defineConfig({
  title: "Hookgres",
  description:
    "Webhooks that commit with your data: signed, retried webhooks queued in your own Postgres transaction. Endpoint health, secret rotation and replay for TypeScript.",
  base: "/docs/",
  ignoreDeadLinks: "localhostLinks",
  cleanUrls: true,
  // Light unless the reader picks dark. The choice lives under
  // "vitepress-theme-appearance", shared with the landing page, as "light" or
  // "dark" only. VitePress can't default to light and saves "auto" whenever
  // the choice matches the OS, so its own state gets a separate key, seeded by
  // the head script below; theme/index.ts saves the shared choice.
  appearance: { storageKey: "hookgres-docs-appearance" },
  lastUpdated: true,
  sitemap: { hostname: "https://hookgres.dev/docs/" },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/docs/logo.svg" }],
    ["meta", { property: "og:image", content: "https://hookgres.dev/og.png" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    [
      "meta",
      {
        name: "theme-color",
        media: "(prefers-color-scheme: light)",
        content: "#fafbfd",
      },
    ],
    [
      "meta",
      {
        name: "theme-color",
        media: "(prefers-color-scheme: dark)",
        content: "#000000",
      },
    ],
    // Before first paint, and after VitePress's own appearance script (which
    // follows the OS and throws when storage is blocked).
    [
      "script",
      {},
      `{let d=false;try{d=localStorage.getItem("vitepress-theme-appearance")==="dark";localStorage.setItem("hookgres-docs-appearance",d?"dark":"light")}catch{}document.documentElement.classList.toggle("dark",d);for(const m of document.querySelectorAll('meta[name="theme-color"]'))m.content=d?"#000000":"#fafbfd"}`,
    ],
  ],
  // The docs home is a hub that wants the full width. Set here rather than in
  // frontmatter because Biome's markdown formatter mangles frontmatter.
  transformPageData(pageData) {
    if (pageData.relativePath === "index.md")
      pageData.frontmatter.aside = false;
    // Each page's own meta description (search results, AI search), taken
    // from its first paragraph instead of repeating the site description.
    const lead = firstParagraph(pageData.relativePath);
    if (lead) pageData.description = lead;
  },
  transformHead({ pageData }) {
    return [["style", {}, currentLinkStyle(pageData.relativePath)]];
  },
  markdown: { theme: codeTheme },
  vite: {
    resolve: {
      alias: [
        {
          find: /^.*\/VPLocalSearchBox\.vue$/,
          replacement: fileURLToPath(
            new URL("./theme/SearchPalette.vue", import.meta.url),
          ),
        },
        { find: /^minisearch$/, replacement: minisearch },
      ],
    },
  },
  themeConfig: {
    logo: { src: "/logo.svg", alt: "" },
    siteTitle: "Hookgres",
    // The brand goes to the landing page, as on hookgres.dev and the playground.
    logoLink: { link: "https://hookgres.dev/", target: "_self" },
    // The same header as the landing page: Docs, Playground and GitHub, then
    // search and "Get started" (added in theme/index.ts).
    nav: [
      { text: "Docs", link: "/", activeMatch: "^/(?!playground)" },
      { text: "Playground", link: "/playground" },
      { text: "GitHub", link: repo },
      { text: "npm", link: "https://www.npmjs.com/package/hookgres" },
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Overview", link: "/" },
          { text: "Getting started", link: "/getting-started" },
          { text: "Playground", link: "/playground" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Sending webhooks", link: "/guides/sending" },
          { text: "Drizzle", link: "/guides/drizzle" },
          { text: "Prisma", link: "/guides/prisma" },
          { text: "Kysely", link: "/guides/kysely" },
          { text: "Endpoints and tenants", link: "/guides/endpoints" },
          { text: "Running workers", link: "/guides/workers" },
          { text: "Retries, failures and replay", link: "/guides/retries" },
          { text: "Rotating secrets", link: "/guides/secret-rotation" },
          { text: "Verifying webhooks", link: "/guides/verifying" },
          { text: "Going to production", link: "/guides/production" },
          { text: "Privacy and GDPR", link: "/guides/privacy" },
          { text: "Migrating from Svix", link: "/guides/migrating-from-svix" },
        ],
      },
      {
        text: "Frameworks",
        items: [
          { text: "Next.js", link: "/frameworks/nextjs" },
          { text: "Express", link: "/frameworks/express" },
          { text: "Hono", link: "/frameworks/hono" },
          { text: "NestJS", link: "/frameworks/nestjs" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "API", link: "/reference/api" },
          { text: "Configuration", link: "/reference/configuration" },
          { text: "Database schema", link: "/reference/schema" },
        ],
      },
      {
        text: "Common questions",
        items: [
          {
            text: "How to send webhooks from Postgres",
            link: "/answers/send-webhooks-from-postgres",
          },
          {
            text: "Transactional outbox in Node.js",
            link: "/answers/transactional-outbox-nodejs",
          },
          {
            text: "A Svix alternative",
            link: "/answers/svix-alternative",
          },
        ],
      },
      { text: "FAQ", link: "/faq" },
    ],
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
    search: {
      provider: "local",
      options: {
        disableDetailedView: true,
        translations: {
          button: { buttonText: "Search docs", buttonAriaLabel: "Search docs" },
        },
      },
    },
    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: "Previous", next: "Next" },
    footer: {
      message: "Released under the MIT License.",
      copyright: "© 2026 Nikos Benakis",
    },
  },
});
