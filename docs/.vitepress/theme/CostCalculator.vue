<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: used in the template
// biome-ignore-all lint/correctness/noUnusedImports: used in the template
// The calculator on docs/compare.md. Every assumption is a control, so readers
// price their own volume instead of trusting ours.
import { computed, ref } from "vue";
import {
  costs,
  formatMoney,
  PRICES_CHECKED,
  prices,
  type StorageProvider,
  total,
} from "./costs";

const presets = [
  { label: "100k", value: 100_000 },
  { label: "1M", value: 1_000_000 },
  { label: "10M", value: 10_000_000 },
  { label: "30M", value: 30_000_000 },
  { label: "100M", value: 100_000_000 },
];

const webhooks = ref(1_000_000);
const endpoints = ref(1);
const retentionDays = ref<7 | 30 | 90>(30);
const staticIps = ref(false);
const storage = ref<StorageProvider>("rds");
const weekCost = ref<number>(prices.build.weekCost);
const buildWeeks = ref<number>(prices.build.weeks);
const maintenanceDays = ref<number>(prices.build.maintenanceDaysPerMonth);

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const volume = computed(() => clamp(webhooks.value, 0, 10_000_000_000));

const rows = computed(() =>
  costs({
    webhooks: volume.value,
    endpoints: clamp(endpoints.value, 1, 100),
    retentionDays: retentionDays.value,
    staticIps: staticIps.value,
    storage: storage.value,
    weekCost: clamp(weekCost.value, 0, 100_000),
    buildWeeks: clamp(buildWeeks.value, 0, 104),
    maintenanceDaysPerMonth: clamp(maintenanceDays.value, 0, 22),
  }),
);

// Against the cheapest hosted option, so the sentence never flatters Hookgres.
const summary = computed(() => {
  const hookgres = rows.value.find((row) => row.id === "hookgres");
  const hosted = rows.value
    .filter((row) => row.id === "outpost" || row.id === "svix")
    .sort((a, b) => total(a, 36) - total(b, 36))[0];
  if (!hookgres || !hosted) return "";
  const ours = total(hookgres, 36);
  const theirs = total(hosted, 36);
  const diff = theirs - ours;
  const verdict =
    Math.abs(diff) < 1
      ? "about the same"
      : diff > 0
        ? `${formatMoney(diff)} less with Hookgres`
        : `${formatMoney(-diff)} less with ${hosted.name}`;
  return `Over three years: Hookgres ${formatMoney(ours)}; the cheapest hosted option, ${hosted.name}, ${formatMoney(theirs)}. ${verdict}.`;
});

const volumeLabel = computed(() => volume.value.toLocaleString("en-US"));
</script>

<template>
  <section class="hg-calc" aria-labelledby="hg-calc-title">
    <h2 id="hg-calc-title" class="hg-calc-title">Price your own volume</h2>
    <div class="hg-calc-controls">
      <div class="hg-calc-field hg-calc-wide">
        <label for="hg-volume"
          >Webhooks per month
          <span class="hg-calc-amount">{{ volumeLabel }}</span></label
        >
        <div class="hg-calc-volume">
          <input
            id="hg-volume"
            v-model.number="webhooks"
            type="number"
            inputmode="numeric"
            min="0"
            step="1000"
          />
          <div class="hg-calc-presets" role="group" aria-label="Common volumes">
            <button
              v-for="preset in presets"
              :key="preset.value"
              type="button"
              :aria-pressed="String(webhooks === preset.value)"
              @click="webhooks = preset.value"
            >
              {{ preset.label }}
            </button>
          </div>
        </div>
      </div>
      <div class="hg-calc-field">
        <label for="hg-endpoints">Endpoints per event</label>
        <select id="hg-endpoints" v-model.number="endpoints">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
          <option :value="5">5</option>
        </select>
      </div>
      <div class="hg-calc-field">
        <label for="hg-retention">History kept</label>
        <select id="hg-retention" v-model.number="retentionDays">
          <option :value="7">7 days</option>
          <option :value="30">30 days</option>
          <option :value="90">90 days</option>
        </select>
      </div>
      <div class="hg-calc-field">
        <label for="hg-storage">Your Postgres</label>
        <select id="hg-storage" v-model="storage">
          <option value="rds">RDS, $0.115/GB</option>
          <option value="supabase">Supabase, $0.125/GB</option>
          <option value="neon">Neon, $0.35/GB</option>
        </select>
      </div>
      <label class="hg-calc-check">
        <input v-model="staticIps" type="checkbox" />
        Customers need fixed IPs to allowlist
      </label>
      <details class="hg-calc-more">
        <summary>Build-it-yourself assumptions</summary>
        <div class="hg-calc-more-grid">
          <div class="hg-calc-field">
            <label for="hg-week">Engineer cost per week ($)</label>
            <input id="hg-week" v-model.number="weekCost" type="number" min="0" step="100" />
          </div>
          <div class="hg-calc-field">
            <label for="hg-build">Weeks to build</label>
            <input id="hg-build" v-model.number="buildWeeks" type="number" min="0" step="1" />
          </div>
          <div class="hg-calc-field">
            <label for="hg-maint">Maintenance days a month</label>
            <input id="hg-maint" v-model.number="maintenanceDays" type="number" min="0" step="0.5" />
          </div>
        </div>
      </details>
    </div>

    <div class="hg-calc-table" role="region" aria-label="Cost per option" tabindex="0">
      <table>
        <caption class="hg-calc-sr">
          Cost of sending {{ volumeLabel }} webhooks a month
        </caption>
        <thead>
          <tr>
            <th scope="col">Option</th>
            <th scope="col" class="num">Per month</th>
            <th scope="col" class="num year">First year</th>
            <th scope="col" class="num">Three years</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" :data-id="row.id">
            <th scope="row">
              {{ row.name }}
              <span class="hg-calc-basis">{{ row.basis }}</span>
            </th>
            <td class="num">{{ formatMoney(row.monthly) }}</td>
            <td class="num year">{{ formatMoney(total(row, 12)) }}</td>
            <td class="num">{{ formatMoney(total(row, 36)) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="hg-calc-summary" aria-live="polite">{{ summary }}</p>
    <p class="hg-calc-note">
      List prices checked {{ PRICES_CHECKED }}. Hookgres storage assumes a
      daily
      <a href="/docs/guides/production#clean-up-old-rows"><code>cleanup()</code></a>
      job keeps only the history you chose. Running costs only: the work to add
      webhooks to your app, and to run them, is left out for every option
      except building it yourself.
    </p>
  </section>
</template>

<style scoped>
.hg-calc {
  margin: 24px 0 32px;
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.hg-calc-title {
  margin: 0 0 16px;
  padding: 0;
  border: 0;
  font-size: 18px;
}
.hg-calc-controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px 16px;
  align-items: end;
}
.hg-calc-wide,
.hg-calc-check,
.hg-calc-more {
  grid-column: 1 / -1;
}
.hg-calc-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.hg-calc-field label {
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-text-2);
}
.hg-calc input[type="number"],
.hg-calc select {
  width: 100%;
  min-height: 40px;
  padding: 0 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}
.hg-calc input:focus-visible,
.hg-calc select:focus-visible,
.hg-calc button:focus-visible,
.hg-calc summary:focus-visible,
.hg-calc-table:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.hg-calc-volume {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.hg-calc-volume input {
  flex: 1 1 180px;
}
.hg-calc-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.hg-calc-presets button {
  min-height: 40px;
  min-width: 52px;
  padding: 0 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.hg-calc-presets button[aria-pressed="true"] {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.hg-calc-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  cursor: pointer;
}
.hg-calc-check input {
  width: 18px;
  height: 18px;
  margin: 0;
}
.hg-calc-more summary {
  font-size: 14px;
  color: var(--vp-c-text-2);
  cursor: pointer;
}
.hg-calc-more-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px 16px;
  margin-top: 12px;
}
.hg-calc-table {
  margin-top: 20px;
  overflow-x: auto;
}
.hg-calc-table table {
  display: table;
  width: 100%;
  margin: 0;
  border-collapse: collapse;
}
.hg-calc-table th,
.hg-calc-table td {
  border: 0;
  border-bottom: 1px solid var(--vp-c-divider);
  padding: 10px 12px;
  background: transparent;
  text-align: left;
  vertical-align: top;
}
.hg-calc-table tr {
  background: transparent;
}
.hg-calc-table .num {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.hg-calc-table tbody th {
  font-weight: 600;
}
.hg-calc-table tr[data-id="hookgres"] th,
.hg-calc-table tr[data-id="hookgres"] td {
  color: var(--vp-c-brand-1);
}
.hg-calc-basis {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  font-weight: 400;
  color: var(--vp-c-text-2);
}
.hg-calc-summary {
  margin: 14px 0 0;
  font-weight: 600;
}
.hg-calc-note {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.hg-calc-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (max-width: 640px) {
  .hg-calc {
    padding: 16px;
  }
  .hg-calc-controls,
  .hg-calc-more-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .hg-calc-table th,
  .hg-calc-table td {
    padding: 8px 6px;
  }
  /* Per month and three years fit beside the names on a phone. */
  .hg-calc-table .year {
    display: none;
  }
}
.hg-calc-amount {
  margin-left: 6px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--vp-c-text-3);
}
</style>
