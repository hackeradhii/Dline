<script lang="ts">
  import type { Snippet } from 'svelte';
  import Band from '../../ui/Band.svelte';
  import Button from '../../ui/Button.svelte';
  import Line from '../../ui/Line.svelte';
  import Plate from '../../ui/Plate.svelte';

  /** Shared frame for every "waiting for the other person" screen (DRY). */
  let { title, children, oncancel }: { title: string; children?: Snippet; oncancel: () => void } = $props();
</script>

<Band>
  {#snippet actions()}<Button variant="band" onclick={oncancel}>Cancel</Button>{/snippet}
  <Line state="connecting" />
  <div class="mt-5"><Plate tone="idle" title="Building the line…" /></div>
</Band>

<main class="mx-auto flex max-w-xl flex-col gap-6 px-4 pt-7 pb-10 sm:px-6">
  <h1 class="text-[1.875rem] leading-tight font-extrabold tracking-[-0.02em] text-balance">{title}</h1>
  {#if children}{@render children()}{/if}
</main>
