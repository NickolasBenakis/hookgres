<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: used in the template
// biome-ignore-all lint/correctness/noUnusedImports: used in the template
// One copy-paste row, like the landing page's: a tag, the text, and an icon
// button whose glyph swaps to a check for 1.6s.
import { onBeforeUnmount, ref } from "vue";

const props = defineProps<{
  tag: string;
  text: string;
  label: string;
  // Shown dimmed before the text and left out of the copy, e.g. "$".
  prompt?: string;
}>();

const state = ref<"idle" | "copied" | "failed">("idle");
const hint = ref("");
const textEl = ref<HTMLElement>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  clearTimeout(timer);
  try {
    await navigator.clipboard.writeText(props.text);
    state.value = "copied";
  } catch {
    // No clipboard access (an insecure origin, or permission denied): select
    // the text so the reader can copy it themselves.
    const selection = window.getSelection();
    if (textEl.value && selection) selection.selectAllChildren(textEl.value);
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    hint.value = `Selected. Press ${mac ? "⌘C" : "Ctrl+C"} to copy.`;
    state.value = "failed";
  }
  // A hint to act on needs longer on screen than a confirmation.
  timer = setTimeout(
    () => {
      state.value = "idle";
    },
    state.value === "failed" ? 4000 : 1600,
  );
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="hg-copy" :data-state="state">
    <span class="hg-copy-tag">{{ tag }}</span>
    <p class="hg-copy-text">
      <span v-if="prompt" class="hg-copy-prompt" aria-hidden="true">{{
        `${prompt} `
      }}</span>
      <span ref="textEl">{{ text }}</span>
    </p>
    <button
      type="button"
      class="hg-copy-button"
      :aria-label="`Copy ${label}`"
      @click="copy"
    >
      <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.25" y="5.25" width="8" height="8" rx="2" />
        <path d="M10.75 5.25V4.5a1.75 1.75 0 0 0-1.75-1.75H4.5A1.75 1.75 0 0 0 2.75 4.5V9a1.75 1.75 0 0 0 1.75 1.75h.75" />
      </svg>
      <svg class="check" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m3.5 8.5 3 3 6-7" />
      </svg>
    </button>
    <span class="hg-copy-status" role="status">{{
      state === "copied" ? "Copied" : state === "failed" ? hint : ""
    }}</span>
  </div>
</template>
