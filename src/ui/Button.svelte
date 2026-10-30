<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  /** `band` is for actions on the navy band, `stage` for the primary action on the dark call stage. */
  type Variant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'band' | 'stage';
  let {
    variant = 'secondary',
    wide = false,
    children,
    ...rest
  }: HTMLButtonAttributes & { variant?: Variant; wide?: boolean; children: Snippet } = $props();

  // Size lives with each variant so no two padding or height classes ever compete.
  const SIZE: Record<Variant, string> = {
    primary: 'min-h-12 px-5',
    secondary: 'min-h-12 px-5',
    danger: 'min-h-12 px-5',
    quiet: 'min-h-11 px-3',
    band: 'min-h-10 px-3',
    stage: 'min-h-12 px-5',
  };
</script>

<button
  type="button"
  {...rest}
  class={[
    'press inline-flex items-center justify-center gap-2 rounded-lg pt-0.5 text-base font-extrabold select-none',
    'disabled:cursor-not-allowed disabled:opacity-45',
    SIZE[variant],
    wide && 'w-full',
    variant === 'primary' && 'bg-line text-line-ink hover:bg-line/90',
    variant === 'secondary' && 'border-2 border-ink/85 text-ink hover:bg-ink/5',
    variant === 'quiet' && 'font-bold text-muted underline-offset-4 hover:text-ink hover:underline',
    variant === 'danger' && 'bg-cut text-white hover:bg-cut/90',
    variant === 'band' && 'font-bold text-band-muted hover:bg-white/10 hover:text-band-ink',
    variant === 'stage' && 'bg-white text-stage hover:bg-white/90',
    rest.class,
  ]}
>
  {@render children()}
</button>
