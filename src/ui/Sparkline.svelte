<script lang="ts">
  /**
   * A small live line of one series, newest on the right; it fills from the right as values arrive.
   * Hovering (or touching) reads out a point; the label describes the whole line for screen readers.
   */
  let {
    values,
    slots,
    label,
    describe,
  }: {
    values: readonly number[];
    /** How many values a full line holds. */
    slots: number;
    label: string;
    /** The readout for the point `ago` values back from the newest. */
    describe: (value: number, ago: number) => string;
  } = $props();

  const W = 240;
  const H = 48;
  const PAD = 3;
  let hover = $state<number | null>(null);

  const max = $derived(Math.max(1, ...values));
  const x = (i: number): number => W - (values.length - 1 - i) * (W / (slots - 1));
  const y = (v: number): number => H - PAD - (v / max) * (H - 2 * PAD);
  const line = $derived(values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '));
  const area = $derived(values.length > 1 ? `${x(0).toFixed(1)},${H} ${line} ${W},${H}` : '');

  function point(event: PointerEvent & { currentTarget: SVGSVGElement }) {
    const box = event.currentTarget.getBoundingClientRect();
    const ago = Math.round(((box.right - event.clientX) / box.width) * (slots - 1));
    hover = ago < values.length ? values.length - 1 - ago : null;
  }
</script>

<div class="relative">
  <svg
    viewBox="0 0 {W} {H}"
    preserveAspectRatio="none"
    class="block h-12 w-full touch-none"
    role="img"
    aria-label={label}
    onpointermove={point}
    onpointerdown={point}
    onpointerleave={() => (hover = null)}
  >
    <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} class="stroke-hairline" stroke-width="1" vector-effect="non-scaling-stroke" />
    {#if area}<polygon points={area} class="fill-line/12" />{/if}
    {#if values.length > 1}
      <polyline points={line} fill="none" class="stroke-line" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    {/if}
    {#if hover !== null}
      <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} class="stroke-muted" stroke-width="1" vector-effect="non-scaling-stroke" />
    {/if}
  </svg>
  {#if hover !== null}
    <p class="tabular pointer-events-none absolute -top-6 right-0 rounded-md bg-ink px-2 py-0.5 text-xs font-bold text-paper">
      {describe(values[hover]!, values.length - 1 - hover)}
    </p>
  {/if}
</div>
