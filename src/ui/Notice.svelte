<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon, { type IconName } from './Icon.svelte';

  type Tone = 'info' | 'warn' | 'error' | 'ok';
  let { tone = 'info', children, ondismiss }: { tone?: Tone; children: Snippet; ondismiss?: () => void } = $props();
  const icon: Record<Tone, IconName> = { info: 'info', warn: 'alert', error: 'alert', ok: 'check' };
</script>

<div
  role={tone === 'error' ? 'alert' : 'status'}
  class={[
    'lift flex items-start gap-3 rounded-[14px] px-4 py-3.5 text-[0.95rem] leading-relaxed',
    tone === 'info' && 'bg-panel',
    tone === 'warn' && 'bg-[color-mix(in_srgb,var(--color-relay)_12%,var(--color-panel))]',
    tone === 'error' && 'bg-[color-mix(in_srgb,var(--color-cut)_11%,var(--color-panel))]',
    tone === 'ok' && 'bg-[color-mix(in_srgb,var(--color-direct)_11%,var(--color-panel))]',
  ]}
>
  <span class={['mt-0.5 shrink-0', tone === 'warn' && 'text-relay', tone === 'error' && 'text-cut', tone === 'ok' && 'text-direct', tone === 'info' && 'text-muted']}>
    <Icon name={icon[tone]} size={19} />
  </span>
  <div class="min-w-0 flex-1">{@render children()}</div>
  {#if ondismiss}
    <button type="button" class="press -m-1 shrink-0 rounded-md p-1 text-muted hover:text-ink" aria-label="Dismiss" onclick={ondismiss}><Icon name="close" size={16} /></button>
  {/if}
</div>
