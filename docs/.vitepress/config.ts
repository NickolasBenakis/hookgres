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

export default defineConfig({
  title: "Hookgres",
  description:
    "Webhooks that commit with your data: signed, retried webhooks queued in your own Postgres transaction. Endpoint health, secret rotation and replay for TypeScript.",
  base: "/docs/",
  ignoreDeadLinks: "localhostLinks",
  cleanUrls: true,
  // Follow the OS colour scheme like the landing page, ignoring any choice
  // stored by older versions of these docs.
  appearance: "force-auto",
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
  ],
  // The docs home is a hub that wants the full width. Set here rather than in
  // frontmatter because Biome's markdown formatter mangles frontmatter.
  transformPageData(pageData) {
    if (pageData.relativePath === "index.md")
      pageData.frontmatter.aside = false;
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
          { text: "Migrating from Svix", link: "/guides/migrating-from-svix" },
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
