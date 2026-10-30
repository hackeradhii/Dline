<script lang="ts">
  import type { FailureReason } from '../../modules/connection';
  import type { NoPathCause } from '../../modules/diagnostics';
  import Band from '../../ui/Band.svelte';
  import Button from '../../ui/Button.svelte';
  import Line from '../../ui/Line.svelte';
  import Plate from '../../ui/Plate.svelte';
  import { CAUSE_COPY, FAILURE_DETAIL, FAILURE_TITLE, NO_PATH_ADVICE } from '../copy';

  let {
    reason,
    causes,
    onrestart,
    onsettings,
    onhome,
  }: { reason: FailureReason; causes: NoPathCause[]; onrestart: () => void; onsettings: () => void; onhome: () => void } = $props();
</script>

<Band>
  <Line state="cut" />
  <div class="mt-5"><Plate tone="cut" title="Not connected" /></div>
</Band>

<main class="mx-auto flex max-w-xl flex-col gap-6 px-4 pt-7 pb-10 sm:px-6">
  <div class="space-y-2">
    <h1 class="text-[1.875rem] leading-tight font-extrabold tracking-[-0.02em] text-balance">{FAILURE_TITLE[reason]}</h1>
    <p class="text-[1.05rem] leading-relaxed text-muted">{FAILURE_DETAIL[reason]}</p>
  </div>

  {#if reason === 'no-path'}
    <section class="lift space-y-5 rounded-[14px] bg-panel p-5 sm:p-6">
      <div>
        <h2 class="font-extrabold">Most likely reason</h2>
        <ul class="mt-2 space-y-1.5 text-muted">
          {#each causes as cause (cause)}<li class="flex gap-2.5"><span class="mt-[0.55em] size-1.5 shrink-0 rounded-full bg-cut"></span>{CAUSE_COPY[cause]}</li>{/each}
        </ul>
      </div>
      <div>
        <h2 class="font-extrabold">What you can do</h2>
        <ul class="mt-2 space-y-1.5 text-muted">
          {#each NO_PATH_ADVICE as tip (tip)}<li class="flex gap-2.5"><span class="mt-[0.55em] size-1.5 shrink-0 rounded-full bg-line"></span>{tip}</li>{/each}
        </ul>
      </div>
    </section>
  {/if}

  <div class="flex flex-wrap gap-3">
    <Button variant="primary" onclick={onrestart}>Start a new line</Button>
    {#if reason === 'no-path'}<Button onclick={onsettings}>Relay settings</Button>{/if}
    <Button variant="quiet" onclick={onhome}>Home</Button>
  </div>
</main>
