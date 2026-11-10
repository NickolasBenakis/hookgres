import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Cost,
  costs,
  formatMoney,
  total,
  type Usage,
} from "../docs/.vitepress/theme/costs.js";

const page = readFileSync(
  new URL("../docs/compare.md", import.meta.url),
  "utf8",
);

const base: Usage = {
  webhooks: 1_000_000,
  endpoints: 1,
  retentionDays: 30,
  staticIps: false,
  storage: "rds",
};

/** The cells after the first one in the row of docs/compare.md labelled `label`. */
function row(label: string): string[] {
  const line = page.split("\n").find((l) => l.startsWith(`| ${label} `));
  if (!line) throw new Error(`No row "${label}" in docs/compare.md`);
  return line
    .split("|")
    .slice(2, -1)
    .map((cell) => cell.trim());
}

function cost(usage: Usage, id: Cost["id"]): Cost {
  const found = costs(usage).find((c) => c.id === id);
  if (!found) throw new Error(`No cost "${id}"`);
  return found;
}

describe("docs/compare.md matches the cost model", () => {
  it.each([100_000, 1_000_000, 10_000_000, 30_000_000, 100_000_000])(
    "monthly costs at %i webhooks",
    (webhooks) => {
      const usage = { ...base, webhooks };
      expect(row(webhooks.toLocaleString("en-US"))).toEqual(
        (["hookgres", "outpost", "svix", "build"] as const).map((id) =>
          formatMoney(cost(usage, id).monthly),
        ),
      );
    },
  );

  it("three-year table", () => {
    for (const [label, id] of [
      ["Hookgres", "hookgres"],
      ["Hookdeck Outpost (managed)", "outpost"],
      ["Svix Basic", "svix"],
      ["Build it yourself", "build"],
    ] as const) {
      const c = cost(base, id);
      expect(row(label)).toEqual([
        formatMoney(total(c, 12)),
        formatMoney(total(c, 36)),
      ]);
    }
  });

  it("fixed IP table", () => {
    const usage = { ...base, staticIps: true };
    for (const [label, id] of [
      ["Hookgres + your own AWS NAT gateway", "hookgres"],
      ["Hookdeck Outpost + static IP add-on", "outpost"],
      ["Svix Pro (static IPs start on Pro)", "svix"],
    ] as const) {
      const c = cost(usage, id);
      expect(row(label)).toEqual([
        formatMoney(c.monthly),
        formatMoney(total(c, 36)),
      ]);
    }
    expect(cost(usage, "svix").name).toBe("Svix Pro");
  });

  it("landing page's price row", () => {
    const landing = readFileSync(
      new URL("../site/index.html", import.meta.url),
      "utf8",
    );
    expect(landing).toContain(
      `about ${formatMoney(cost(base, "hookgres").monthly)} of storage</td><td>${formatMoney(cost(base, "outpost").monthly)} on Hookdeck Outpost, ${formatMoney(cost(base, "svix").monthly)} on Svix Basic`,
    );
  });

  it("upfront build cost", () => {
    const { upfront } = cost(base, "build");
    expect(page).toContain(
      `about **$${upfront.toLocaleString("en-US")} up front**`,
    );
  });
});

describe("cost model", () => {
  it("bills Hookdeck per delivery and Svix per event", () => {
    const one = { ...base, webhooks: 10_000_000 };
    const three = { ...one, endpoints: 3 };
    expect(cost(three, "outpost").monthly).toBeGreaterThan(
      cost(one, "outpost").monthly * 2.9,
    );
    expect(cost(three, "svix").monthly).toBe(cost(one, "svix").monthly);
    expect(cost(three, "hookgres").monthly).toBeCloseTo(
      cost(one, "hookgres").monthly * 3,
    );
  });

  it("puts Svix on Pro for 90 days of history and on Free under 50k", () => {
    expect(cost({ ...base, retentionDays: 90 }, "svix").name).toBe("Svix Pro");
    expect(
      cost({ ...base, webhooks: 40_000, retentionDays: 7 }, "svix").monthly,
    ).toBe(0);
  });
});
