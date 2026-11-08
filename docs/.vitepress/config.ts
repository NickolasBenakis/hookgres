import { defineConfig } from "vitepress";
import { codeTheme } from "./code-theme";

const repo = "https://github.com/NickolasBenakis/hookgres";

export default defineConfig({
  title: "Hookgres",
  description:
    "Reliable, signed webhooks from the Postgres you already run. Retries, endpoint health, secret rotation and replay for TypeScript.",
  base: "/docs/",
  ignoreDeadLinks: "localhostLinks",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: "https://hookgres.dev/docs/" },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/docs/logo.svg" }],
    ["meta", { property: "og:image", content: "https://hookgres.dev/og.png" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  markdown: { theme: codeTheme },
  themeConfig: {
    logo: { src: "/logo.svg", alt: "" },
    siteTitle: "Hookgres",
    nav: [
      {
        text: "Guide",
        link: "/getting-started",
        activeMatch: "^/(getting-started|playground|guides/)",
      },
      {
        text: "Reference",
        link: "/reference/api",
        activeMatch: "^/reference/",
      },
      { text: "FAQ", link: "/faq" },
      { text: "hookgres.dev", link: "https://hookgres.dev/" },
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "What is Hookgres?", link: "/" },
          { text: "Getting started", link: "/getting-started" },
          { text: "Playground", link: "/playground" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Sending webhooks", link: "/guides/sending" },
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
    socialLinks: [
      { icon: "github", link: repo },
      { icon: "npm", link: "https://www.npmjs.com/package/hookgres" },
    ],
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    footer: {
      message: "Released under the MIT License.",
      copyright: "© 2026 Nikos Benakis",
    },
  },
});
