<script lang="ts">
  import type { Snippet } from 'svelte';

  /** The navy signage band at the top of every screen: the wordmark, then the line and its status. */
  let { wide = false, actions, children }: { wide?: boolean; actions?: Snippet; children: Snippet } = $props();
</script>

<header class="bg-band text-band-ink">
  <div class={['mx-auto px-4 sm:px-6', wide ? 'max-w-6xl' : 'max-w-xl']}>
    <div class="flex h-14 items-center justify-between gap-4">
      <span class="flex items-center gap-2 text-[1.3rem] font-extrabold tracking-[-0.02em]">
        <svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
          <path d="M7 7h20" stroke="var(--color-band-line)" stroke-width="4" />
          <circle cx="6" cy="7" r="4.5" fill="var(--color-band-ink)" stroke="var(--color-band-line)" stroke-width="3" />
          <circle cx="28" cy="7" r="4.5" fill="var(--color-band-ink)" stroke="var(--color-band-line)" stroke-width="3" />
        </svg>
        Dline
      </span>
      {#if actions}{@render actions()}{/if}
    </div>
    <div class="pt-1 pb-5">{@render children()}</div>
  </div>
</header>
