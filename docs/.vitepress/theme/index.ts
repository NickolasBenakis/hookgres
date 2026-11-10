// The docs use the system font stack, like the landing page, so the bundled
// Inter webfont is left out.
import type { Theme } from "vitepress";
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import { h, nextTick, onMounted, ref, watch } from "vue";
import CopyLine from "./CopyLine.vue";
import CostCalculator from "./CostCalculator.vue";
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

      // The reader's choice, shared with the landing page (see config.ts).
      const KEY = "vitepress-theme-appearance";
      const { isDark } = useData();
      const storedDark = () => {
        try {
          return localStorage.getItem(KEY) === "dark";
        } catch {
          return false;
        }
      };
      // Saved only when the reader switches, never when useDark follows the OS.
      const save = () => {
        try {
          localStorage.setItem(KEY, isDark.value ? "dark" : "light");
        } catch {}
      };
      const toggleTheme = () => {
        // Switch every colour at once instead of a ragged cascade of transitions.
        const freeze = document.createElement("style");
        freeze.textContent = "*,*::before,*::after{transition:none!important}";
        document.head.append(freeze);
        isDark.value = !isDark.value;
        save();
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
        // Without readable storage VitePress falls back to the OS theme.
        isDark.value = storedDark();
        // A page restored by Back/Forward missed changes made on other pages,
        // and other tabs announce theirs.
        addEventListener("pageshow", (event) => {
          if (event.persisted) isDark.value = storedDark();
        });
        addEventListener("storage", (event) => {
          if (event.key === KEY) isDark.value = storedDark();
        });
        // VitePress's switch in the mobile menu.
        document.addEventListener("click", (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".VPNavScreenAppearance .VPSwitch")
          )
            nextTick(save);
        });
        // useDark may hold "auto" and follow an OS switch; put the reader's
        // choice back once it has, before the next paint.
        matchMedia("(prefers-color-scheme: dark)").addEventListener(
          "change",
          () =>
            requestAnimationFrame(() => {
              isDark.value = storedDark();
            }),
        );
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
    app.component("CostCalculator", CostCalculator);
    app.component("DocsHub", DocsHub);
  },
} satisfies Theme;
