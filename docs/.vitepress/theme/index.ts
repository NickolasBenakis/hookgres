// The docs use the system font stack, like the landing page, so the bundled
// Inter webfont is left out.
import type { Theme } from "vitepress";
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import { h, onMounted, ref, watch } from "vue";
import CopyLine from "./CopyLine.vue";
import DocsHub from "./DocsHub.vue";
import "./custom.css";

// The landing page's theme icons (site/index.html), so both headers match.
const sun = h(
  "svg",
  {
    class: "sun",
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "aria-hidden": "true",
  },
  [
    h("circle", { cx: "10", cy: "10", r: "3.5" }),
    h("path", {
      d: "M10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.34 4.34l1.06 1.06M14.6 14.6l1.06 1.06M4.34 15.66l1.06-1.06M14.6 5.4l1.06-1.06",
    }),
  ],
);
const moon = h(
  "svg",
  {
    class: "moon",
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  },
  [
    h("path", {
      d: "M16.5 12.2A6.75 6.75 0 0 1 7.8 3.5a6.75 6.75 0 1 0 8.7 8.7Z",
    }),
  ],
);

export default {
  extends: DefaultTheme,
  Layout: {
    setup() {
      // Children mount first, so the sidebar has marked its current link by
      // now and the prerendered highlight in config.ts can step aside.
      onMounted(() => {
        document.documentElement.classList.add("hg-ready");
      });

      // VitePress stores the choice ("auto" when it matches the OS) under the
      // key the landing page reads too.
      const { isDark } = useData();
      const toggleTheme = () => {
        // Switch every colour at once instead of a ragged cascade of transitions.
        const freeze = document.createElement("style");
        freeze.textContent = "*,*::before,*::after{transition:none!important}";
        document.head.append(freeze);
        isDark.value = !isDark.value;
        getComputedStyle(document.documentElement).color;
        requestAnimationFrame(() => freeze.remove());
      };
      // The browser's toolbar colour follows the chosen theme, not just the OS.
      watch(isDark, (dark) => {
        for (const meta of document.querySelectorAll(
          'meta[name="theme-color"]',
        ))
          meta.setAttribute("content", dark ? "#000000" : "#fafbfd");
      });
      // The server always renders light, so the button's state waits for
      // mount; rendering isDark straight away would leave a stale
      // aria-pressed after hydration for readers in dark mode.
      const mounted = ref(false);
      onMounted(() => {
        mounted.value = true;
        // A page restored by Back/Forward missed changes made on other pages.
        addEventListener("pageshow", (event) => {
          if (!event.persisted) return;
          let stored: string | null = null;
          try {
            stored = localStorage.getItem("vitepress-theme-appearance");
          } catch {}
          isDark.value =
            stored === "dark" ||
            (stored !== "light" &&
              matchMedia("(prefers-color-scheme: dark)").matches);
        });
      });

      return () => {
        const dark = mounted.value && isDark.value;
        return h(DefaultTheme.Layout, null, {
          "nav-bar-content-after": () => [
            h(
              "button",
              {
                type: "button",
                class: "hg-theme-toggle",
                "aria-label": "Dark theme",
                "aria-pressed": String(dark),
                title: dark ? "Switch to light theme" : "Switch to dark theme",
                onClick: toggleTheme,
              },
              [sun, moon],
            ),
            h("a", { class: "hg-cta", href: "/docs/getting-started" }, [
              "Get started",
            ]),
          ],
        });
      };
    },
  },
  enhanceApp({ app }) {
    app.component("CopyLine", CopyLine);
    app.component("DocsHub", DocsHub);
  },
} satisfies Theme;
