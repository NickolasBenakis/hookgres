<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: used in the template
// biome-ignore-all lint/correctness/noUnusedImports: used in the template
import { withBase } from "vitepress";
import CopyLine from "./CopyLine.vue";

const guides = [
  ["Sending", "/guides/sending"],
  ["Endpoints", "/guides/endpoints"],
  ["Workers", "/guides/workers"],
  ["Retries and replay", "/guides/retries"],
  ["Secret rotation", "/guides/secret-rotation"],
  ["Verifying", "/guides/verifying"],
  ["Production", "/guides/production"],
  ["From Svix", "/guides/migrating-from-svix"],
] as const;

const reference = [
  ["API", "/reference/api"],
  ["Configuration", "/reference/configuration"],
  ["Database schema", "/reference/schema"],
  ["FAQ", "/faq"],
] as const;
</script>

<template>
  <div class="hg-hub">
    <div class="hg-hub-start">
      <CopyLine
        tag="Agent"
        label="the prompt for your AI agent"
        text="Add Hookgres webhooks to this app: hookgres.dev/llms.txt"
      />
      <CopyLine
        tag="npm"
        prompt="$"
        label="the install command"
        text="npm install hookgres pg"
      />
    </div>

    <nav class="hg-hub-grid" aria-label="Start here">
      <a class="hg-card" :href="withBase('/getting-started')">
        <span class="hg-card-title">Getting started</span>
        <span class="hg-card-text">
          Install, run <code>migrate()</code>, then send and verify your first
          webhook.
        </span>
        <span class="hg-card-meta">5 minutes</span>
      </a>
      <a class="hg-card" :href="withBase('/playground')">
        <span class="hg-card-title">Playground</span>
        <span class="hg-card-text">
          Watch retries, a disabled endpoint and a replay against three fake
          receivers.
        </span>
        <span class="hg-card-meta">docker compose up</span>
      </a>
      <a class="hg-card" href="/llms.txt">
        <span class="hg-card-title">llms.txt</span>
        <span class="hg-card-text">
          Every page as plain markdown, for Claude Code, Cursor and other
          agents.
        </span>
        <span class="hg-card-meta">/llms-full.txt for one file</span>
      </a>
      <section class="hg-card hg-card-wide" aria-labelledby="hg-hub-guides">
        <a id="hg-hub-guides" class="hg-card-title" :href="withBase('/guides/sending')">Guides</a>
        <span class="hg-card-text">
          Tenants and endpoints, workers in any process, the 28-hour retry
          schedule, going live.
        </span>
        <ul class="hg-card-links">
          <li v-for="[text, link] in guides" :key="link">
            <a :href="withBase(link)">{{ text }}</a>
          </li>
        </ul>
      </section>
      <section class="hg-card hg-card-wide" aria-labelledby="hg-hub-reference">
        <a id="hg-hub-reference" class="hg-card-title" :href="withBase('/reference/api')">Reference</a>
        <span class="hg-card-text">
          Every method on <code>Hookgres</code>, each config option and its
          default, and the tables it creates.
        </span>
        <ul class="hg-card-links">
          <li v-for="[text, link] in reference" :key="link">
            <a :href="withBase(link)">{{ text }}</a>
          </li>
        </ul>
      </section>
    </nav>
  </div>
</template>
