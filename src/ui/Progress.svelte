<script lang="ts">
  let { value, tone = 'line', label }: { value: number; tone?: 'line' | 'direct' | 'cut'; label: string } = $props();
  const pct = $derived(Math.max(0, Math.min(100, value * 100)));
</script>

<div class="h-1.5 w-full overflow-hidden rounded-full bg-hairline" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
  <div
    class={['h-full rounded-full transition-[width] duration-300 ease-[var(--ease-out)]', tone === 'line' && 'bg-line', tone === 'direct' && 'bg-direct', tone === 'cut' && 'bg-cut']}
    style:width="{pct}%"
  ></div>
</div>
