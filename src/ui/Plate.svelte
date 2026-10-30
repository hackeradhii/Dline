<script lang="ts" module>
  export type PlateTone = 'direct' | 'relay' | 'cut' | 'idle';
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * The line-name plate under the line, like a metro line's sign: purple while the line runs
   * direct, amber when it goes through a relay, red when it is down, faint while it is not built.
   * `flat` keeps only the lamp's colour, for status that sits near a primary button (the home screen).
   */
  let { tone, title, flat = false, children }: { tone: PlateTone; title: string; flat?: boolean; children?: Snippet } = $props();
</script>

<span
  class={[
    'inline-flex max-w-full items-start gap-x-2.5 rounded-lg px-3 pt-[0.45rem] pb-[0.35rem] text-[0.95rem] leading-snug',
    flat && 'text-band-ink ring-1 ring-white/20 ring-inset',
    !flat && tone === 'direct' && 'bg-band-plate text-white',
    !flat && tone === 'relay' && 'bg-band-relay text-band',
    !flat && tone === 'cut' && 'bg-band-down text-white',
    !flat && tone === 'idle' && 'bg-white/10 text-band-ink',
  ]}
>
  <span
    class={[
      'mt-[0.3em] size-2.5 shrink-0 rounded-full',
      tone === 'direct' && 'bg-band-direct',
      tone === 'relay' && (flat ? 'bg-band-relay' : 'bg-band'),
      tone === 'cut' && (flat ? 'bg-band-cut' : 'bg-white'),
      tone === 'idle' && 'bg-band-muted',
    ]}
    aria-hidden="true"
  ></span>
  <span class="min-w-0">
    <strong class="font-extrabold">{title}</strong>{#if children}<span class="tabular opacity-80">{@render children()}</span>{/if}
  </span>
</span>
