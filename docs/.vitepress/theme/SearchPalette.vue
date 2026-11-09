<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: used in the template
// biome-ignore-all lint/correctness/noUnusedImports: used in the template
// Replaces VitePress's local search box (aliased in config.ts), keeping its
// index and its triggers (the nav button, ⌘K / Ctrl+K and "/"). Results are
// grouped by page, the input is 16px so iOS doesn't zoom, and the arrow keys
// move through the groups in reading order.
import localSearchIndex from "@localSearchIndex";
import MiniSearch from "minisearch";
import { useData, useRouter, withBase } from "vitepress";
import {
  computed,
  markRaw,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";

interface Doc {
  title: string;
  titles: string[];
}

interface Item {
  href: string;
  title: string;
  crumbs: string[];
  page: boolean;
}

interface Group {
  label: string;
  items: Item[];
}

interface SidebarEntry {
  text?: string;
  link?: string;
  items?: SidebarEntry[];
}

const emit = defineEmits<{ close: [] }>();

const { localeIndex, theme } = useData();
const router = useRouter();

const root = ref<HTMLElement>();
const input = ref<HTMLInputElement>();
const list = ref<HTMLElement>();

const storageKey = "vitepress:local-search-filter";
const query = ref(readQuery());
const index = shallowRef<MiniSearch<Doc>>();
const selected = ref(0);
// Hovering selects a row only after the pointer actually moves, so a row
// that ends up under a still cursor while typing doesn't steal the selection.
let pointerMoved = false;

function readQuery() {
  try {
    return sessionStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

watch(query, (value) => {
  try {
    sessionStorage.setItem(storageKey, value);
  } catch {}
});

// Set when the index chunk can't be fetched (offline, or a stale tab after a
// deploy), so the panel says so instead of staying blank.
const loadFailed = ref(false);

onMounted(async () => {
  let data: { default: string } | undefined;
  try {
    data = await localSearchIndex[localeIndex.value]?.();
  } catch {}
  if (!data) {
    loadFailed.value = true;
    return;
  }
  index.value = markRaw(
    MiniSearch.loadJSON<Doc>(data.default, {
      fields: ["title", "titles", "text"],
      storeFields: ["title", "titles"],
      searchOptions: {
        fuzzy: 0.2,
        prefix: true,
        boost: { title: 4, text: 2, titles: 1 },
      },
    }),
  );
});

// With no query, the sidebar doubles as a list of places to jump to.
const browse = computed<Group[]>(() => {
  const sidebar = (theme.value.sidebar ?? []) as SidebarEntry[];
  const groups: Group[] = [];
  const loose: Item[] = [];
  const toItem = (entry: SidebarEntry): Item => ({
    href: withBase(entry.link ?? "/"),
    title: escapeHtml(entry.text ?? ""),
    crumbs: [],
    page: true,
  });
  for (const entry of sidebar) {
    if (entry.items?.length) {
      groups.push({
        label: entry.text ?? "",
        items: entry.items.filter((item) => item.link).map(toItem),
      });
    } else if (entry.link) {
      loose.push(toItem(entry));
    }
  }
  if (loose.length) groups.push({ label: "More", items: loose });
  return groups;
});

const groups = computed<Group[]>(() => {
  const q = query.value.trim();
  if (!q) return browse.value;
  if (!index.value) return [];
  const hits = index.value.search(q).slice(0, 30);
  // Highlight what was typed, not MiniSearch's fuzzy matches: predictable,
  // and it never marks half a word for a reason the reader can't see.
  const pattern = markPattern(new Set(q.split(/\s+/).filter(Boolean)));
  const byPage = new Map<string, Group>();
  for (const hit of hits) {
    const id = String(hit.id);
    const page = id.split("#")[0] ?? id;
    const titles = (hit.titles as string[]) ?? [];
    const title = hit.title as string;
    let group = byPage.get(page);
    if (!group) {
      group = { label: stripTags(titles[0] ?? title), items: [] };
      byPage.set(page, group);
    }
    group.items.push({
      href: id,
      title: mark(title, pattern),
      crumbs: titles.slice(1).map((t) => mark(t, pattern)),
      page: titles.length === 0,
    });
  }
  return [...byPage.values()];
});

const items = computed(() => groups.value.flatMap((group) => group.items));
const offsets = computed(() => {
  let n = 0;
  return groups.value.map((group) => {
    const start = n;
    n += group.items.length;
    return start;
  });
});

const status = computed(() => {
  if (!query.value.trim()) return "";
  if (loadFailed.value) return "Search couldn't load";
  if (!index.value) return "Loading…";
  const n = items.value.length;
  return n === 1 ? "1 result" : `${n} results`;
});

watch(items, () => {
  selected.value = 0;
  if (list.value) list.value.scrollTop = 0;
});

function move(by: number) {
  const n = items.value.length;
  if (!n) return;
  selected.value = (selected.value + by + n) % n;
  nextTick(() => {
    list.value
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  });
}

function open(item: Item | undefined) {
  if (!item) return;
  router.go(item.href);
  emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    pointerMoved = false;
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    pointerMoved = false;
    move(-1);
  } else if (event.key === "Enter" && !event.isComposing) {
    // Buttons and the no-results link handle Enter themselves.
    if (event.target instanceof HTMLButtonElement) return;
    if (event.target instanceof HTMLAnchorElement) return;
    event.preventDefault();
    open(items.value[selected.value]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  } else if (event.key === "Tab") {
    trapFocus(event);
  }
}

function trapFocus(event: KeyboardEvent) {
  const focusable = [
    ...(root.value?.querySelectorAll<HTMLElement>(
      'input, button, a[href]:not([tabindex="-1"])',
    ) ?? []),
  ];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!root.value?.contains(document.activeElement)) {
    event.preventDefault();
    first?.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

// Clicking padding, a group label or the footer would otherwise move focus
// to <body> and out of the dialog.
function keepFocus(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (!target.closest("input, button, a")) event.preventDefault();
}

function onPointerMove(index: number) {
  if (!pointerMoved) {
    pointerMoved = true;
    return;
  }
  selected.value = index;
}

// iOS doesn't shrink the layout viewport for the keyboard, so size the panel
// to the visual viewport or the last results would sit under the keyboard.
function fitViewport() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  root.value?.style.setProperty("--hg-vvh", `${height}px`);
}

let returnFocus: HTMLElement | null = null;
let overflow = "";

onMounted(() => {
  returnFocus = document.activeElement as HTMLElement | null;
  overflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";
  fitViewport();
  window.visualViewport?.addEventListener("resize", fitViewport);
  // On window, so the keys work wherever focus is while the palette is open.
  window.addEventListener("keydown", onKeydown);
  input.value?.focus();
  input.value?.select();
});

onBeforeUnmount(() => {
  document.documentElement.style.overflow = overflow;
  window.visualViewport?.removeEventListener("resize", fitViewport);
  window.removeEventListener("keydown", onKeydown);
  returnFocus?.focus?.();
});

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripTags(html: string) {
  const el = document.createElement("span");
  el.innerHTML = html;
  return el.textContent ?? "";
}

function markPattern(terms: Set<string>) {
  const parts = [...terms]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return parts.length ? new RegExp(parts.join("|"), "gi") : null;
}

// Index titles are HTML: wrap matches in <mark>, skipping tags and entities.
function mark(html: string, pattern: RegExp | null) {
  if (!pattern) return html;
  return html
    .split(/(<[^>]+>|&[#\w]+;)/)
    .map((part) =>
      part.startsWith("<") || /^&[#\w]+;$/.test(part)
        ? part
        : part.replace(pattern, "<mark>$&</mark>"),
    )
    .join("");
}
</script>

<template>
  <Teleport to="body">
    <div ref="root" class="hg-search">
      <div class="hg-search-backdrop" @click="emit('close')" />
      <div
        class="hg-search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search docs"
        @mousedown="keepFocus"
      >
        <form class="hg-search-bar" role="search" @submit.prevent>
          <svg class="hg-search-icon" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.75" cy="8.75" r="5.75" />
            <path d="M13 13l4 4" />
          </svg>
          <input
            ref="input"
            v-model="query"
            class="hg-search-input"
            type="search"
            role="combobox"
            aria-label="Search docs"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="hg-search-list"
            :aria-activedescendant="
              items.length ? `hg-search-item-${selected}` : undefined
            "
            placeholder="Search docs"
            autocapitalize="off"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            enterkeyhint="go"
            maxlength="64"
          />
          <button
            type="button"
            class="hg-search-close"
            aria-label="Close search"
            @click="emit('close')"
          >
            <span class="hg-search-close-key">esc</span>
            <span class="hg-search-close-text">Cancel</span>
          </button>
        </form>

        <div
          id="hg-search-list"
          ref="list"
          class="hg-search-results"
          role="listbox"
          aria-label="Results"
        >
          <div
            v-for="(group, g) in groups"
            :key="group.label + g"
            class="hg-search-group"
            role="group"
            :aria-labelledby="`hg-search-group-${g}`"
          >
            <div :id="`hg-search-group-${g}`" class="hg-search-group-label">
              {{ group.label }}
            </div>
            <a
              v-for="(item, i) in group.items"
              :id="`hg-search-item-${offsets[g]! + i}`"
              :key="item.href"
              :href="item.href"
              class="hg-search-item"
              role="option"
              tabindex="-1"
              :aria-selected="selected === offsets[g]! + i"
              @pointermove="onPointerMove(offsets[g]! + i)"
              @click="emit('close')"
            >
              <svg
                v-if="item.page"
                class="hg-search-kind"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path d="M4.5 2.75h4.75l2.75 2.75v7.75H4.5z" />
                <path d="M9.25 2.75V5.5H12" />
              </svg>
              <span v-else class="hg-search-kind hg-search-hash" aria-hidden="true">#</span>
              <span class="hg-search-label">
                <span class="hg-search-title" v-html="item.title" />
                <span v-if="item.crumbs.length" class="hg-search-crumbs">
                  <span v-for="(crumb, c) in item.crumbs" :key="c" v-html="crumb" />
                </span>
              </span>
              <kbd class="hg-search-enter" aria-hidden="true">↵</kbd>
            </a>
          </div>

          <div
            v-if="query.trim() && loadFailed"
            class="hg-search-empty"
          >
            <p>Search couldn’t load.</p>
            <p>Check your connection, then reload the page.</p>
          </div>
          <div
            v-else-if="query.trim() && !index"
            class="hg-search-empty hg-search-loading"
          >
            <p>Loading search…</p>
          </div>
          <div
            v-else-if="query.trim() && !items.length"
            class="hg-search-empty"
          >
            <p>
              No results for “<strong>{{ query.trim() }}</strong>”.
            </p>
            <p>
              Try an API name like <code>verifyWebhook</code>, or read
              everything in <a href="/llms-full.txt">llms-full.txt</a>.
            </p>
          </div>
        </div>

        <div class="hg-search-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>esc</kbd> Close</span>
        </div>
        <span class="hg-search-status" role="status">{{ status }}</span>
      </div>
    </div>
  </Teleport>
</template>
