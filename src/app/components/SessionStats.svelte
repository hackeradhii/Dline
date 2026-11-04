<script lang="ts">
  import type { SideTally } from '../../modules/metrics';
  import { METRICS, STATS } from '../../shared/config';
  import { formatBytes, formatSpeed, formatVideo, plural } from '../../shared/format';
  import Sparkline from '../../ui/Sparkline.svelte';
  import type { RoomState } from '../state/room.svelte';

  /** Live performance of this session: file speed both ways, totals, average and peak, and the call's video. */
  let { room }: { room: RoomState } = $props();

  const sides = $derived<Array<{ name: string; arrow: string; side: SideTally | undefined }>>([
    { name: 'Upload', arrow: '↑', side: room.tally?.up },
    { name: 'Download', arrow: '↓', side: room.tally?.down },
  ]);
  const ago = (ticks: number): string => (ticks === 0 ? 'now' : `${Math.round((ticks * STATS.intervalMs) / 1000)} s ago`);
  /** The call's video without the codec: the connection details have that. */
  const videoText = (v: { width: number | null; height: number | null; fps: number | null } | null | undefined): string =>
    formatVideo(v && { width: v.width, height: v.height, fps: v.fps });
  const inCall = $derived(room.callState === 'active');
</script>

<section aria-labelledby="stats-title" class="rounded-[14px] bg-panel p-5 ring-1 ring-hairline">
  <h2 id="stats-title" class="text-[1.375rem] font-extrabold tracking-[-0.01em]">Session stats</h2>

  <div class="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
    {#each sides as { name, arrow, side } (name)}
      <div>
        <div class="flex items-baseline justify-between gap-3">
          <h3 class="text-sm font-bold text-muted"><span aria-hidden="true">{arrow}</span> {name}</h3>
          <p class="tabular text-xl font-extrabold">{formatSpeed(side?.bps ?? 0)}</p>
        </div>
        <div class="mt-2">
          <Sparkline
            values={side?.history ?? []}
            slots={METRICS.historyTicks}
            label="{name} speed over the last minute, now {formatSpeed(side?.bps ?? 0)}, peak {formatSpeed(side?.peakBps ?? 0)}"
            describe={(value, ticks) => `${ago(ticks)}: ${formatSpeed(value)}`}
          />
        </div>
        <dl class="tabular mt-2 grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt class="text-muted">Total</dt>
            <dd class="font-semibold">{formatBytes(side?.bytes ?? 0)}</dd>
          </div>
          <div>
            <dt class="text-muted">Average</dt>
            <dd class="font-semibold">{formatSpeed(side?.avgBps ?? 0)}</dd>
          </div>
          <div>
            <dt class="text-muted">Peak</dt>
            <dd class="font-semibold">{formatSpeed(side?.peakBps ?? 0)}</dd>
          </div>
        </dl>
        <p class="mt-1 text-sm text-muted">
          {plural(side?.files ?? 0, 'file')}
          {name === 'Upload' ? 'sent' : 'received'}{side?.failed ? `, ${side.failed} failed` : ''}
        </p>
      </div>
    {/each}
  </div>

  {#if inCall}
    <dl class="tabular mt-5 grid grid-cols-2 gap-2 border-t border-hairline pt-4 text-sm">
      <div>
        <dt class="text-muted">Your video</dt>
        <dd class="font-semibold">{videoText(room.snapshot?.outboundVideo)}</dd>
      </div>
      <div>
        <dt class="text-muted">Their video</dt>
        <dd class="font-semibold">{videoText(room.snapshot?.inboundVideo)}</dd>
      </div>
    </dl>
  {/if}
</section>
