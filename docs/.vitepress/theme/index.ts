// The docs use the system font stack, like the landing page, so the bundled
// Inter webfont is left out.
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import { h, onMounted } from "vue";
import CopyLine from "./CopyLine.vue";
import DocsHub from "./DocsHub.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: {
    setup() {
      // Children mount first, so the sidebar has marked its current link by
      // now and the prerendered highlight in config.ts can step aside.
      onMounted(() => document.documentElement.classList.add("hg-ready"));
      return () =>
        h(DefaultTheme.Layout, null, {
          "nav-bar-content-after": () =>
            h("a", { class: "hg-cta", href: "/docs/getting-started" }, [
              "Get started",
            ]),
        });
    },
  },
  enhanceApp({ app }) {
    app.component("CopyLine", CopyLine);
    app.component("DocsHub", DocsHub);
  },
} satisfies Theme;
