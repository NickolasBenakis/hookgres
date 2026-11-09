// The landing page's code palette (site/index.html), as hex because Shiki
// writes colours inline. Code blocks are dark panels in both colour schemes,
// so one theme serves light and dark mode.
const ink = "#e3e4e8"; // --code-ink oklch(92% 0.005 270)
const dim = "#898c94"; // --code-dim oklch(64% 0.012 270)
const key = "#85bcf5"; // --code-key oklch(78% 0.1 250)
const str = "#95d7a2"; // --code-str oklch(82% 0.1 150)
const bg = "#121417"; // --code-bg oklch(19% 0.008 270)

export const codeTheme = {
  name: "hookgres",
  type: "dark" as const,
  colors: {
    "editor.background": bg,
    "editor.foreground": ink,
  },
  tokenColors: [
    { settings: { foreground: ink } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: dim },
    },
    {
      scope: ["string", "punctuation.definition.string", "markup.inserted"],
      settings: { foreground: str },
    },
    {
      scope: [
        "keyword",
        "storage",
        "variable.language",
        "constant.language",
        "entity.name.tag",
      ],
      settings: { foreground: key },
    },
    {
      // Operators and punctuation stay quiet, as on the landing page.
      scope: ["keyword.operator", "punctuation"],
      settings: { foreground: ink },
    },
    {
      // Shell commands read as plain text, like the landing page's terminal.
      scope: ["string.unquoted.argument.shell", "constant.other.option"],
      settings: { foreground: ink },
    },
    {
      scope: ["keyword.operator.new", "keyword.operator.expression"],
      settings: { foreground: key },
    },
  ],
};
