<script lang="ts" module>
  export type LineState = 'idle' | 'connecting' | 'direct' | 'relay' | 'cut';
</script>

<script lang="ts">
  /**
   * Dline's signature: the connection drawn as a two-station metro line, for the navy band.
   * planned (dashed, faint) = not paired, dashes running = connecting, solid = direct,
   * interchange in the middle = relayed, broken = lost. Each tick is a lane carrying files, and a
   * train runs along the line while files are moving.
   */
  let {
    state,
    lanes = 0,
    moving = false,
    compact = false,
  }: { state: LineState; lanes?: number; moving?: boolean; compact?: boolean } = $props();

  const live = $derived(state === 'direct' || state === 'relay');
  const ticks = $derived(live ? Math.min(lanes, 16) : 0);
</script>

<span class="metro" data-state={state} data-compact={compact} aria-hidden="true">
  <span class="station"></span>
  <span class="track">
    {#each { length: ticks }, i (i)}
      <span class="tick" style:left="{((i + 1) / (ticks + 1)) * 100}%"></span>
    {/each}
    {#if moving && live}<span class="train"></span>{/if}
    {#if state === 'relay'}<span class="interchange">Relay</span>{/if}
    {#if state === 'cut'}<span class="break"></span>{/if}
  </span>
  <span class={['station', state === 'idle' && 'planned']}></span>
  <span class="name">You</span>
  <span class="name end">Them</span>
</span>

<style>
  .metro {
    --c: var(--color-band-line);
    --stop: 24px;
    --ring: 5px;
    --thick: 8px;
    display: grid;
    grid-template-columns: var(--stop) 1fr var(--stop);
    grid-template-rows: var(--stop) auto;
    align-items: center;
    column-gap: 0;
    row-gap: 6px;
    color: var(--color-band-ink);
  }
  .metro[data-compact='true'] {
    --stop: 18px;
    --ring: 4px;
    --thick: 6px;
    row-gap: 4px;
  }
  .metro[data-state='cut'] {
    --c: var(--color-band-cut);
  }
  .station {
    position: relative;
    z-index: 1;
    width: var(--stop);
    height: var(--stop);
    border-radius: 50%;
    background: var(--color-band-ink);
    box-shadow: inset 0 0 0 var(--ring) var(--c);
  }
  .station.planned {
    background: transparent;
    box-shadow: inset 0 0 0 2px var(--color-band-muted);
  }
  .track {
    position: relative;
    container-type: inline-size;
    height: var(--thick);
    margin-inline: -2px;
    border-radius: var(--thick);
    background: var(--c);
  }
  [data-state='idle'] .track,
  [data-state='connecting'] .track {
    background: repeating-linear-gradient(90deg, var(--c) 0 10px, transparent 10px 18px);
    height: calc(var(--thick) - 2px);
  }
  [data-state='idle'] .track {
    --c: var(--color-band-muted);
    opacity: 0.45;
  }
  [data-state='connecting'] .track {
    animation: build 0.8s linear infinite;
  }
  .tick {
    position: absolute;
    top: 100%;
    width: 3px;
    height: 7px;
    margin-left: -1.5px;
    background: var(--c);
    border-radius: 0 0 2px 2px;
  }
  .train {
    position: absolute;
    top: 50%;
    left: 0;
    width: 22px;
    height: calc(var(--thick) + 6px);
    margin-top: calc((var(--thick) + 6px) / -2);
    border-radius: 99px;
    background: var(--color-band-ink);
    box-shadow: 0 0 0 2px var(--c);
    animation: run 1.6s var(--ease-drawer) infinite;
  }
  .interchange {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    padding: 1px 9px 0;
    border-radius: 99px;
    background: var(--color-band-ink);
    color: var(--color-band);
    box-shadow: 0 0 0 3px var(--color-band-relay);
    font-size: 0.75rem;
    font-weight: 800;
    line-height: 1.4;
  }
  .break {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 22px;
    height: calc(var(--stop) + 4px);
    transform: translate(-50%, -50%) skewX(-24deg);
    background: var(--color-band);
  }
  .name {
    grid-row: 2;
    grid-column: 1;
    justify-self: start;
    font-size: 0.875rem;
    font-weight: 800;
    white-space: nowrap;
  }
  .name.end {
    grid-column: 3;
    justify-self: end;
  }
  [data-compact='true'] .name {
    font-size: 0.75rem;
  }
  @keyframes build {
    to {
      background-position: 18px 0;
    }
  }
  @keyframes run {
    from {
      transform: translateX(0);
      opacity: 0;
    }
    12%,
    88% {
      opacity: 1;
    }
    to {
      transform: translateX(calc(100cqw - 22px));
      opacity: 0;
    }
  }
</style>
