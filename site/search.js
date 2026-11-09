// Docs search for hookgres.dev: a command palette over /search-index.json,
// which scripts/build-site.mjs builds from docs/. No dependencies.
//
// Integration: any element with [data-search-open] opens it, as do ⌘K / Ctrl+K
// and "/". Elements with [data-search-kbd] get the platform's shortcut label.
(() => {
  const platform =
    navigator.userAgentData?.platform || navigator.platform || "";
  const shortcutLabel = /mac|iphone|ipad|ipod/i.test(platform)
    ? "⌘K"
    : "Ctrl K";
  const RECENT_KEY = "hookgres:search-recent";
  const SUGGESTED = [
    "/docs/getting-started",
    "/docs/playground",
    "/docs/guides/sending",
    "/docs/guides/retries",
    "/docs/guides/production",
    "/docs/reference/api",
    "/llms.txt",
  ];
  const MAX_RESULTS = 40;
  const MAX_PER_PAGE = 6;
  const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
  const HIDDEN = { opacity: 0, transform: "scale(0.98)" };
  const SHOWN = { opacity: 1, transform: "none" };

  const ICONS = {
    search:
      '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="8.75" cy="8.75" r="5.75"/><path d="m13.25 13.25 4 4"/></svg>',
    page: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M5 2.75h6.5L15.25 6.5v10.75H5z"/><path d="M11.25 2.75V6.75h4" /><path d="M7.75 10.25h4.5M7.75 13.25h4.5" stroke-linecap="round"/></svg>',
    section:
      '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5 6.5 16.5M13.5 3.5 12 16.5M4 7.5h12.5M3.5 12.5H16"/></svg>',
    link: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 5.5h7v7M14.5 5.5l-9 9"/></svg>',
    recent:
      '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="6.75"/><path d="M10 6.25V10l2.5 1.75"/></svg>',
    enter:
      '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 4.5v5.25a2 2 0 0 1-2 2H5"/><path d="m8 8.5-3 3.25L8 15"/></svg>',
  };

  const CSS = `
html:has(dialog.hgs[open]) { overflow: hidden; }
.hgs {
  --hgs-bg: var(--surface, #fff);
  --hgs-ink: var(--ink, #1d1d1f);
  --hgs-ink-2: var(--ink-2, #6e6e73);
  --hgs-ink-3: var(--ink-3, #6e6e73);
  --hgs-line: var(--line, #e3e3e8);
  --hgs-accent: var(--accent, #2b6cb0);
  --hgs-active: color-mix(in oklab, var(--hgs-accent) 10%, transparent);
  --hgs-chip: color-mix(in oklab, var(--hgs-ink) 7%, transparent);
  --hgs-scrim: rgb(0 0 0 / 0.16);
  --hgs-glass: color-mix(in oklab, var(--hgs-bg) 74%, transparent);
  --hgs-shadow: inset 0 1px 0 rgb(255 255 255 / 0.7), 0 0 0 0.5px rgb(0 0 0 / 0.14), 0 4px 12px rgb(0 0 0 / 0.06), 0 24px 64px -12px rgb(0 0 0 / 0.3);
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  background: transparent;
  color: var(--hgs-ink);
  font: 15px/1.4 var(--sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  letter-spacing: -0.006em;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
@media (prefers-color-scheme: dark) {
  .hgs {
    --hgs-bg: var(--surface, #1c1c1e);
    --hgs-ink: var(--ink, #f5f5f7);
    --hgs-ink-2: var(--ink-2, #a1a1a6);
    --hgs-ink-3: var(--ink-3, #98989d);
    --hgs-line: var(--line, #38383a);
    --hgs-accent: var(--accent, #6cb0f5);
    --hgs-active: color-mix(in oklab, var(--hgs-accent) 16%, transparent);
    --hgs-chip: color-mix(in oklab, var(--hgs-ink) 10%, transparent);
    --hgs-scrim: rgb(0 0 0 / 0.45);
    --hgs-glass: color-mix(in oklab, var(--hgs-bg) 70%, transparent);
    --hgs-shadow: inset 0 1px 0 rgb(255 255 255 / 0.08), 0 0 0 1px rgb(255 255 255 / 0.1), 0 24px 64px rgb(0 0 0 / 0.6);
  }
}
.hgs[open] { display: flex; flex-direction: column; align-items: center; }
.hgs::backdrop { background: transparent; }
@media (prefers-reduced-transparency: reduce) { .hgs { --hgs-glass: var(--hgs-bg); } }
.hgs *, .hgs *::before, .hgs *::after { box-sizing: border-box; }
.hgs-scrim { position: absolute; inset: 0; background: var(--hgs-scrim); }
.hgs-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(640px, calc(100% - 32px));
  height: min(520px, calc(100% - 12vh - 32px));
  margin-top: 12vh;
  border-radius: 16px;
  /* Frosted like Spotlight: the page shows through, blurred. */
  background: var(--hgs-glass);
  -webkit-backdrop-filter: saturate(180%) blur(30px);
  backdrop-filter: saturate(180%) blur(30px);
  box-shadow: var(--hgs-shadow);
  overflow: hidden;
  isolation: isolate;
}
.hgs-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  height: 56px;
  margin: 0;
  padding: 0 10px 0 18px;
  border-bottom: 1px solid var(--hgs-line);
}
.hgs-bar > svg { flex: none; color: var(--hgs-ink-3); }
.hgs-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--hgs-ink);
  font: inherit;
  font-size: 17px;
  letter-spacing: -0.016em;
  caret-color: var(--hgs-accent);
  -webkit-appearance: none;
  appearance: none;
}
.hgs-input::placeholder { color: var(--hgs-ink-3); opacity: 1; }
.hgs-input::-webkit-search-cancel-button, .hgs-input::-webkit-search-decoration { -webkit-appearance: none; }
.hgs-close {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  height: 32px;
  margin: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--hgs-ink-2);
  font: inherit;
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
}
.hgs-close::before { content: ""; position: absolute; inset: -6px -4px; }
.hgs-close:focus-visible { outline: 2px solid var(--hgs-ink-3); outline-offset: 0; }
.hgs-close > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.hgs kbd {
  display: inline-grid;
  place-items: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--hgs-chip);
  color: var(--hgs-ink-2);
  font: 500 11.5px/1 var(--sans, system-ui, sans-serif);
  letter-spacing: 0;
}
.hgs-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: 8px;
  scroll-padding: 8px 0;
}
.hgs-msg { padding: 20px 20px 4px; color: var(--hgs-ink-2); }
.hgs-msg strong { display: block; margin-bottom: 2px; color: var(--hgs-ink); font-weight: 600; overflow-wrap: anywhere; }
.hgs-msg button {
  margin-top: 12px;
  padding: 7px 14px;
  border: 0;
  border-radius: 999px;
  background: var(--hgs-chip);
  color: var(--hgs-ink);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  touch-action: manipulation;
}
.hgs-msg button:focus-visible { outline: 2px solid var(--hgs-ink-3); outline-offset: 2px; }
.hgs-label {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: 0;
  padding: 12px 20px 6px;
  background: color-mix(in oklab, var(--hgs-bg) 45%, transparent);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  color: var(--hgs-ink-3);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
}
.hgs-opt {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  column-gap: 12px;
  align-items: center;
  margin: 0 8px;
  padding: 9px 12px;
  border-radius: 6px;
  color: var(--hgs-ink);
  text-decoration: none;
  cursor: pointer;
  scroll-margin-top: 34px;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
}
.hgs-opt:hover { text-decoration: none; }
.hgs-opt[aria-selected="true"] { background: var(--hgs-active); }
.hgs-opt > svg { color: var(--hgs-ink-3); }
.hgs-opt[aria-selected="true"] > svg { color: var(--hgs-accent); }
.hgs-opt-main { min-width: 0; }
.hgs-opt-title, .hgs-opt-text { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hgs-opt-title { font-weight: 500; }
.hgs-opt-parent { color: var(--hgs-ink-3); font-weight: 400; }
.hgs-opt-text { margin-top: 1px; color: var(--hgs-ink-2); font-size: 13px; }
.hgs-opt-enter { color: var(--hgs-ink-3); visibility: hidden; }
.hgs-opt[aria-selected="true"] .hgs-opt-enter { visibility: visible; }
.hgs mark { background: none; color: var(--hgs-accent); }
.hgs-foot {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: none;
  height: 40px;
  padding: 0 18px;
  border-top: 1px solid var(--hgs-line);
  color: var(--hgs-ink-3);
  font-size: 12px;
}
.hgs-foot span { display: inline-flex; align-items: center; gap: 4px; }
.hgs-foot kbd { min-width: 20px; height: 20px; font-size: 11px; }
.hgs-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (hover: none), (pointer: coarse) {
  .hgs-foot, .hgs-opt-enter { display: none; }
}
@media (max-width: 640px) {
  .hgs-panel {
    width: 100%;
    height: 100%;
    margin: 0;
    border-radius: 0;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) 0 env(safe-area-inset-left, 0px);
    box-shadow: none;
    transform-origin: 50% 0;
  }
  .hgs-bar { padding: 0 4px 0 16px; }
  .hgs-close { height: 44px; padding: 0 12px; color: var(--hgs-accent); font-size: 17px; }
  .hgs-close::before { inset: 0; }
  .hgs-close > kbd { display: none; }
  .hgs-close > span { position: static; width: auto; height: auto; overflow: visible; clip-path: none; }
  .hgs-body { padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)); }
  .hgs-label { padding-inline: 16px; }
  .hgs-opt { margin: 0 4px; padding: 11px 12px; }
  .hgs-opt-text { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
}
@media (hover: hover) and (pointer: fine) {
  .hgs-close:hover { background: var(--hgs-chip); }
  .hgs-msg button:hover { background: color-mix(in oklab, var(--hgs-ink) 12%, transparent); }
}
`;

  const TEMPLATE = `
<div class="hgs-scrim"></div>
<div class="hgs-panel">
  <form class="hgs-bar" role="search">
    ${ICONS.search}
    <input class="hgs-input" type="search" role="combobox" aria-label="Search docs" aria-expanded="false" aria-controls="hgs-list" aria-autocomplete="list" placeholder="Search docs" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" data-1p-ignore data-lpignore="true" autofocus>
    <button type="button" class="hgs-close"><kbd aria-hidden="true">esc</kbd><span>Cancel</span></button>
  </form>
  <div class="hgs-body">
    <div class="hgs-msg" hidden></div>
    <div class="hgs-list" id="hgs-list" role="listbox" aria-label="Results"></div>
  </div>
  <div class="hgs-foot" aria-hidden="true">
    <span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span>
    <span><kbd>↵</kbd> to open</span>
    <span><kbd>esc</kbd> to close</span>
  </div>
  <div class="hgs-sr" role="status"></div>
</div>`;

  let indexPromise = null;
  let entries = null;
  let dialog, panel, scrim, input, list, msg, status;
  let options = [];
  let active = -1;
  let state = "closed";
  let anims = [];

  // ---- index and ranking ----

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch("/search-index.json")
        .then((response) => {
          if (!response.ok)
            throw new Error(`search index: HTTP ${response.status}`);
          return response.json();
        })
        .then(prepare);
      indexPromise.catch(() => {
        indexPromise = null;
      });
    }
    return indexPromise;
  }

  function wordsOf(text) {
    const split = (s) => s.toLowerCase().split(/[^a-z0-9]+/);
    const camel = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    return [...new Set([...split(text), ...split(camel)])].filter(Boolean);
  }

  function prepare({ pages, sections }) {
    entries = sections.map((s) => {
      const page = pages[s.p].t;
      const head = s.h || page;
      return {
        ...s,
        page,
        head,
        headLower: `${s.ph ? `${s.ph} ` : ""}${head}`.toLowerCase(),
        headWords: wordsOf(`${s.ph ?? ""} ${head}`),
        titleWords: wordsOf(page),
        keyWords: wordsOf(s.k ?? ""),
        bodyLower: s.b.toLowerCase(),
        bodyWords: wordsOf(s.b),
      };
    });
  }

  // "retries" -> "retr", "rotate" -> "rotat": lets "retry" find "Retries" and
  // "rotate secret" find "Rotating secrets".
  function stem(token) {
    const cut = token.replace(/(?:ies|es|ing|ed|e|s|y)$/, "");
    return token.length > 4 && cut.length >= 3 ? cut : token;
  }

  function withinOneEdit(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i++;
        j++;
        continue;
      }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else {
        i++;
        j++;
      }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  // A one-typo prefix match: "signture" still finds "signature".
  const nearPrefix = (word, token) =>
    [token.length - 1, token.length, token.length + 1].some(
      (n) => n <= word.length && withinOneEdit(word.slice(0, n), token),
    );

  function scoreToken(e, token) {
    const root = stem(token);
    const starts = (words, t) => words.some((w) => w.startsWith(t));
    if (e.headWords.includes(token)) return 40;
    if (starts(e.headWords, token)) return 30;
    if (starts(e.headWords, root)) return 24;
    if (e.headLower.includes(token)) return 16;
    if (starts(e.titleWords, root)) return 12;
    if (starts(e.keyWords, root)) return 9;
    if (
      token.length >= 4 &&
      (e.headWords.some((w) => nearPrefix(w, token)) ||
        e.titleWords.some((w) => nearPrefix(w, token)))
    )
      return 8;
    if (starts(e.bodyWords, token)) return 4;
    if (starts(e.bodyWords, root)) return 3;
    if (token.length >= 5 && e.bodyWords.some((w) => nearPrefix(w, token)))
      return 2;
    if (token.length >= 3 && e.bodyLower.includes(token)) return 1;
    return 0;
  }

  function search(query) {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .flatMap(wordsOf);
    if (!tokens.length) return [];
    const phrase = query.trim().toLowerCase();
    const hits = [];
    for (const e of entries) {
      let score = 0;
      for (const token of tokens) {
        const s = scoreToken(e, token);
        if (!s) {
          score = 0;
          break;
        }
        // Sections that keep talking about the term beat a passing mention.
        score += s + Math.min(e.bodyLower.split(token).length - 1, 5) * 0.75;
      }
      if (!score) continue;
      if (tokens.length > 1 && e.headLower.includes(phrase)) score += 20;
      if (tokens.length > 1 && e.bodyLower.includes(phrase)) score += 6;
      hits.push({ e, score: score - e.head.length / 100 });
    }
    hits.sort((a, b) => b.score - a.score);

    const groups = new Map();
    const seen = new Set();
    let count = 0;
    for (const { e } of hits) {
      // "Playground" is both a docs page and a landing link; list it once.
      if (seen.has(e.u)) continue;
      seen.add(e.u);
      const group = groups.get(e.p) ?? groups.set(e.p, []).get(e.p);
      if (group.length >= MAX_PER_PAGE) continue;
      group.push(e);
      if (++count >= MAX_RESULTS) break;
    }
    return [...groups.values()].map((items) => ({
      label: items[0].page,
      items,
    }));
  }

  function termsFor(query) {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .flatMap(wordsOf);
    return [...new Set(tokens.flatMap((t) => [t, stem(t)]))].sort(
      (a, b) => b.length - a.length,
    );
  }

  // Start offsets of terms that begin a word (or a camelCase hump) in text.
  function matches(text, terms, limit = Infinity) {
    const lower = text.toLowerCase();
    const found = [];
    for (let i = 0; i < lower.length && found.length < limit; i++) {
      const boundary =
        i === 0 ||
        !/[a-z0-9]/.test(lower[i - 1]) ||
        (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));
      if (!boundary) continue;
      const term = terms.find((t) => lower.startsWith(t, i));
      if (term) {
        found.push([i, i + term.length]);
        i += term.length - 1;
      }
    }
    return found;
  }

  function snippet(text, terms) {
    const [first] = matches(text, terms, 1);
    let start = 0;
    if (first && first[0] > 50)
      start = text.lastIndexOf(" ", first[0] - 36) + 1;
    let end = Math.min(text.length, start + 180);
    if (end < text.length) end = text.lastIndexOf(" ", end);
    return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  }

  function highlighted(text, terms) {
    const fragment = document.createDocumentFragment();
    let at = 0;
    for (const [from, to] of terms.length ? matches(text, terms) : []) {
      fragment.append(text.slice(at, from));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(from, to);
      fragment.append(mark);
      at = to;
    }
    fragment.append(text.slice(at));
    return fragment;
  }

  // ---- recent results (per browser; storage may be unavailable) ----

  function readRecent() {
    try {
      const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      return Array.isArray(saved)
        ? saved
            .filter((r) =>
              [r?.u, r?.t, r?.p].every((v) => typeof v === "string"),
            )
            .slice(0, 5)
        : [];
    } catch {
      return [];
    }
  }

  function remember(entry) {
    const item = { u: entry.u, t: entry.head, p: entry.page };
    try {
      localStorage.setItem(
        RECENT_KEY,
        JSON.stringify(
          [item, ...readRecent().filter((r) => r.u !== item.u)].slice(0, 5),
        ),
      );
    } catch {}
  }

  // ---- rendering ----

  function iconFor(entry) {
    if (entry.recent) return ICONS.recent;
    if (!entry.u.startsWith("/docs/")) return ICONS.link;
    return entry.h ? ICONS.section : ICONS.page;
  }

  function render() {
    const query = input.value.trim();
    msg.hidden = true;
    msg.replaceChildren();
    if (!entries) {
      showMessage("Loading…");
      setGroups([]);
      loadIndex().then(() => dialog.open && render(), showError);
      return;
    }
    if (!query) {
      const recent = readRecent().map((r) => ({
        u: r.u,
        head: r.t,
        page: r.p,
        b: r.p === r.t ? "" : r.p,
        recent: true,
      }));
      setGroups(
        recent.length
          ? [{ label: "Recent", items: recent }, suggested()]
          : [suggested()],
      );
      status.textContent = "";
      return;
    }
    const groups = search(query);
    const count = groups.reduce((n, group) => n + group.items.length, 0);
    if (!count) {
      showMessage(
        `No results for “${query}”`,
        "Try another word, or start with one of these:",
      );
    }
    setGroups(count ? groups : [suggested()], termsFor(query));
    status.textContent = count
      ? `${count} result${count === 1 ? "" : "s"}`
      : `No results for ${query}`;
  }

  function suggested() {
    return {
      label: "Suggested",
      items: SUGGESTED.map((u) => entries.find((e) => e.u === u)).filter(
        Boolean,
      ),
    };
  }

  function showMessage(title, detail) {
    const strong = document.createElement("strong");
    strong.textContent = title;
    msg.append(strong);
    if (detail) msg.append(detail);
    msg.hidden = false;
  }

  function setGroups(groups, terms = []) {
    options = [];
    active = -1;
    list.replaceChildren(
      ...groups.map((group, g) => {
        const wrap = document.createElement("div");
        wrap.setAttribute("role", "group");
        wrap.setAttribute("aria-labelledby", `hgs-g${g}`);
        const label = document.createElement("p");
        label.className = "hgs-label";
        label.id = `hgs-g${g}`;
        label.textContent = group.label;
        wrap.append(label);
        for (const entry of group.items) wrap.append(optionFor(entry, terms));
        return wrap;
      }),
    );
    input.setAttribute("aria-expanded", String(options.length > 0));
    list.parentElement.scrollTop = 0;
    setActive(options.length ? 0 : -1);
  }

  function optionFor(entry, terms) {
    const i = options.length;
    const a = document.createElement("a");
    a.className = "hgs-opt";
    a.id = `hgs-o${i}`;
    a.href = entry.u;
    a.tabIndex = -1;
    a.setAttribute("role", "option");
    a.setAttribute("aria-selected", "false");
    a.dataset.i = i;
    a.innerHTML = iconFor(entry);

    const main = document.createElement("span");
    main.className = "hgs-opt-main";
    const title = document.createElement("span");
    title.className = "hgs-opt-title";
    if (entry.ph) {
      const parent = document.createElement("span");
      parent.className = "hgs-opt-parent";
      parent.textContent = `${entry.ph} › `;
      title.append(parent);
    }
    title.append(highlighted(entry.head, terms));
    main.append(title);
    const body = entry.recent ? entry.b : snippet(entry.b, terms);
    if (body) {
      const text = document.createElement("span");
      text.className = "hgs-opt-text";
      text.append(highlighted(body, terms));
      main.append(text);
    }
    a.append(main);
    a.insertAdjacentHTML(
      "beforeend",
      `<span class="hgs-opt-enter">${ICONS.enter}</span>`,
    );
    options.push({ el: a, entry });
    return a;
  }

  function setActive(i, scroll = false) {
    options[active]?.el.setAttribute("aria-selected", "false");
    active = i;
    const option = options[i];
    if (!option) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    option.el.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", option.el.id);
    if (scroll && i === 0) list.parentElement.scrollTop = 0;
    else if (scroll) option.el.scrollIntoView({ block: "nearest" });
  }

  function activate(i, newTab) {
    const option = options[i];
    if (!option) return;
    remember(option.entry);
    if (newTab) {
      window.open(option.entry.u, "_blank", "noopener");
      return;
    }
    navigate(option.entry.u);
  }

  function navigate(href) {
    const url = new URL(href, location.href);
    if (url.origin === location.origin && url.pathname === location.pathname)
      close();
    location.assign(url);
  }

  // ---- dialog ----

  function build() {
    if (dialog) return;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);

    dialog = document.createElement("dialog");
    dialog.className = "hgs";
    dialog.setAttribute("aria-label", "Search docs");
    dialog.innerHTML = TEMPLATE;
    document.body.append(dialog);
    scrim = dialog.querySelector(".hgs-scrim");
    panel = dialog.querySelector(".hgs-panel");
    input = dialog.querySelector(".hgs-input");
    list = dialog.querySelector(".hgs-list");
    msg = dialog.querySelector(".hgs-msg");
    status = dialog.querySelector(".hgs-sr");

    input.addEventListener("input", render);
    input.addEventListener("keydown", onInputKey);
    dialog
      .querySelector("form")
      .addEventListener("submit", (event) => event.preventDefault());
    dialog.querySelector(".hgs-close").addEventListener("click", close);
    dialog.addEventListener("click", (event) => {
      if (event.target === scrim || event.target === dialog) close();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      close();
    });
    dialog.addEventListener("close", () => {
      state = "closed";
      for (const anim of anims) anim.cancel();
      anims = [];
    });
    list.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse") return;
      const option = event.target.closest(".hgs-opt");
      if (option && Number(option.dataset.i) !== active)
        setActive(Number(option.dataset.i));
    });
    list.addEventListener("click", (event) => {
      const option = event.target.closest(".hgs-opt");
      if (!option) return;
      const { entry } = options[Number(option.dataset.i)];
      remember(entry);
      const url = new URL(entry.u, location.href);
      if (url.origin === location.origin && url.pathname === location.pathname)
        close();
    });
  }

  function onInputKey(event) {
    if (event.isComposing) return;
    const down =
      event.key === "ArrowDown" || (event.ctrlKey && event.key === "n");
    const up = event.key === "ArrowUp" || (event.ctrlKey && event.key === "p");
    if ((down || up) && options.length) {
      event.preventDefault();
      setActive(
        (active + (down ? 1 : -1) + options.length) % options.length,
        true,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(active, event.metaKey || event.ctrlKey);
    }
  }

  function showError() {
    if (!dialog?.open) return;
    msg.replaceChildren();
    showMessage(
      "Search couldn’t load.",
      "Check your connection and try again.",
    );
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => {
      render();
      loadIndex().then(render, showError);
      input.focus();
    });
    msg.append(document.createElement("br"), retry);
  }

  // Animates panel and scrim from wherever they are now, so closing midway
  // through opening (or the reverse) reverses smoothly instead of jumping.
  function animateTo(show) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches)
      return Promise.resolve();
    const running = anims.length > 0;
    const from = running
      ? [
          {
            opacity: getComputedStyle(panel).opacity,
            transform: getComputedStyle(panel).transform,
          },
          { opacity: getComputedStyle(scrim).opacity },
        ]
      : [show ? HIDDEN : SHOWN, { opacity: show ? 0 : 1 }];
    for (const anim of anims) anim.cancel();
    const timing = { duration: show ? 200 : 140, easing: EASE, fill: "both" };
    anims = [
      panel.animate([from[0], show ? SHOWN : HIDDEN], timing),
      scrim.animate([from[1], { opacity: show ? 1 : 0 }], timing),
    ];
    const current = anims;
    return Promise.all(current.map((anim) => anim.finished)).then(
      () => {
        if (anims !== current) return;
        if (show) for (const anim of current) anim.cancel();
        if (show) anims = [];
      },
      () => {},
    );
  }

  function open() {
    build();
    if (state === "open") return;
    // state is still "closing" between dialog.close() and its close event.
    if (!dialog.open) {
      dialog.showModal();
      render();
    }
    state = "open";
    input.focus();
    input.select();
    animateTo(true);
  }

  function close() {
    if (state !== "open") return;
    state = "closing";
    animateTo(false).then(() => {
      if (state === "closing") dialog.close();
    });
  }

  // ---- wiring ----

  const isTyping = (el) =>
    el instanceof Element &&
    el.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    );

  document.addEventListener("keydown", (event) => {
    if (event.isComposing || event.defaultPrevented) return;
    if (
      (event.key === "k" || event.key === "K") &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      if (state === "open") close();
      else open();
    } else if (
      event.key === "/" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      state !== "open" &&
      !isTyping(event.target)
    ) {
      event.preventDefault();
      open();
    }
  });

  document.addEventListener("click", (event) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest("[data-search-open]")
    )
      return;
    event.preventDefault();
    open();
  });

  // Fetch the index as soon as someone reaches for the trigger.
  const prefetch = (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-search-open]")
    )
      loadIndex().catch(() => {});
  };
  document.addEventListener("pointerover", prefetch, { passive: true });
  document.addEventListener("focusin", prefetch);

  // Coming back with the back button restores the page as it was left.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && dialog?.open) dialog.close();
  });

  function fillShortcutLabels() {
    for (const el of document.querySelectorAll("[data-search-kbd]"))
      el.textContent = shortcutLabel;
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", fillShortcutLabels);
  else fillShortcutLabels();

  window.hookgresSearch = { open, close, shortcutLabel };
})();
