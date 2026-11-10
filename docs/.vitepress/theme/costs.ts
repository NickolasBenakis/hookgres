// The cost model behind docs/compare.md and its calculator. List prices as
// published on PRICES_CHECKED; test/costs.test.ts keeps the page's tables in
// line with these numbers.

export const PRICES_CHECKED = "2026-11-10";

export const prices = {
  svix: {
    // svix.com/pricing: 50k messages included on every plan, then $0.0001
    // each. Basic keeps 30 days; Pro keeps 90 days and adds static IPs.
    included: 50_000,
    perMessage: 0.0001,
    basic: 20,
    pro: 490,
  },
  outpost: {
    // hookdeck.com/outpost/pricing: first 50k free, then $10 per million.
    // Counted per delivery to each destination; static IPs +$100.
    included: 50_000,
    perMillion: 10,
    staticIp: 100,
  },
  hookgres: {
    // docs/guides/database-cost.md: ~1.3 KB stored per webhook (one endpoint).
    gbPerWebhook: 1.3e-6,
    // An AWS NAT gateway in us-east-1: $0.045 an hour.
    natGateway: 32.85,
  },
  storage: {
    // $ per GB-month.
    rds: 0.115,
    supabase: 0.125,
    neon: 0.35,
  },
  build: {
    // BLS median software developer pay ($133,080, May 2024) plus 30%
    // overhead, per week.
    weekCost: 3_300,
    weeks: 4,
    maintenanceDaysPerMonth: 2,
  },
} as const;

export type StorageProvider = keyof typeof prices.storage;

export interface Usage {
  /** Webhook events sent per month. */
  webhooks: number;
  /** Endpoints that receive each event. */
  endpoints: number;
  /** Days of delivery history kept. */
  retentionDays: 7 | 30 | 90;
  /** Customers need a fixed source IP to allowlist. */
  staticIps: boolean;
  storage: StorageProvider;
  weekCost?: number;
  buildWeeks?: number;
  maintenanceDaysPerMonth?: number;
}

export interface Cost {
  id: "hookgres" | "outpost" | "svix" | "build";
  name: string;
  /** What the number is made of, in a few words. */
  basis: string;
  monthly: number;
  /** Paid once, before the first month (building it yourself). */
  upfront: number;
}

export function costs(usage: Usage): Cost[] {
  const deliveries = usage.webhooks * usage.endpoints;

  const storedGb =
    deliveries * prices.hookgres.gbPerWebhook * (usage.retentionDays / 30);
  const infra =
    storedGb * prices.storage[usage.storage] +
    (usage.staticIps ? prices.hookgres.natGateway : 0);

  // Svix doesn't say how fan-out is billed, so count per event, the reading
  // that makes Svix cheapest.
  const svixPro = usage.staticIps || usage.retentionDays > 30;
  const svixFree =
    !svixPro &&
    usage.retentionDays <= 7 &&
    usage.webhooks <= prices.svix.included;
  const svixBase = svixFree ? 0 : svixPro ? prices.svix.pro : prices.svix.basic;
  const svix =
    svixBase +
    Math.max(0, usage.webhooks - prices.svix.included) * prices.svix.perMessage;

  const outpost =
    (Math.max(0, deliveries - prices.outpost.included) / 1e6) *
      prices.outpost.perMillion +
    (usage.staticIps ? prices.outpost.staticIp : 0);

  const weekCost = usage.weekCost ?? prices.build.weekCost;
  const buildWeeks = usage.buildWeeks ?? prices.build.weeks;
  const maintenanceDays =
    usage.maintenanceDaysPerMonth ?? prices.build.maintenanceDaysPerMonth;

  return [
    {
      id: "hookgres",
      name: "Hookgres",
      basis: `${formatGb(storedGb)} in your Postgres${usage.staticIps ? " + NAT gateway" : ""}`,
      monthly: infra,
      upfront: 0,
    },
    {
      id: "outpost",
      name: "Hookdeck Outpost (managed)",
      basis: `$10 per million deliveries${usage.staticIps ? " + $100 static IPs" : ""}`,
      monthly: outpost,
      upfront: 0,
    },
    {
      id: "svix",
      name: `Svix ${svixFree ? "Free" : svixPro ? "Pro" : "Basic"}`,
      basis: svixFree
        ? "Free plan"
        : `$${svixBase} plan + $0.0001 per message${svixPro ? (usage.staticIps ? " (Pro for static IPs)" : " (Pro for 90 days)") : ""}`,
      monthly: svix,
      upfront: 0,
    },
    {
      id: "build",
      name: "Build it yourself",
      basis: `${buildWeeks} weeks to build, ${maintenanceDays} days a month to maintain`,
      monthly: (maintenanceDays * weekCost) / 5 + infra,
      upfront: buildWeeks * weekCost,
    },
  ];
}

/** Total paid over the first `months` months. */
export function total(cost: Cost, months: number): number {
  return cost.upfront + cost.monthly * months;
}

function formatGb(gb: number): string {
  return gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb.toFixed(1)} GB`;
}

export function formatMoney(value: number): string {
  if (value === 0) return "$0";
  if (value < 1) return `$${value.toFixed(2)}`;
  if (value < 100) return `$${value.toFixed(value < 10 ? 2 : 0)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
