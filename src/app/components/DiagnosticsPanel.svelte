<script lang="ts">
  import { describeCandidate, type ConnectionSnapshot } from '../../modules/diagnostics';
  import type { PacingStatus } from '../../modules/transfer';
  import { formatBitrate, formatBytes, formatMs, NO_VALUE } from '../../shared/format';
  import Button from '../../ui/Button.svelte';
  import Icon from '../../ui/Icon.svelte';
  import { filePacingCopy, PACING_MODE_COPY } from '../copy';

  let {
    snapshot,
    mode,
    rtt,
    lanes,
    safetyWords,
    pacing,
    callActive,
    debug,
    onsavetrace,
  }: {
    snapshot: ConnectionSnapshot | null;
    mode: 'rendezvous' | 'link';
    rtt: number | null;
    lanes: number;
    safetyWords: string[] | null;
    pacing: PacingStatus | null;
    callActive: boolean;
    /** `?debug=1`: show the pacing mode and offer the trace. */
    debug: boolean;
    onsavetrace: () => void;
  } = $props();

  const path = $derived(snapshot?.path ?? null);
  const video = $derived(snapshot?.inboundVideo);
  const rows = $derived<Array<[string, string]>>([
    ['Pairing', mode === 'rendezvous' ? 'Room code (handshake via rendezvous)' : 'Links only (no server at all)'],
    ['Your side', path ? describeCandidate(path.local) : NO_VALUE],
    ['Their side', path ? describeCandidate(path.remote) : NO_VALUE],
    ['Round trip', formatMs(pacing?.pingMs ?? snapshot?.rttMs ?? rtt)],
    ['Upload queue', formatMs(pacing?.queueMs ?? null)],
    ['File pacing', pacing ? filePacingCopy(pacing.limit, callActive) : NO_VALUE],
    ['File lanes', lanes > 1 ? `${lanes} parallel direct paths` : lanes === 1 ? '1 (the main connection)' : NO_VALUE],
    ['Sending', formatBitrate(snapshot?.sendBps ?? NaN)],
    ['Receiving', formatBitrate(snapshot?.receiveBps ?? NaN)],
    ['Packet loss', snapshot?.lossPercent == null ? NO_VALUE : `${snapshot.lossPercent.toFixed(1)}%`],
    ['Their video', video?.width ? `${video.width}×${video.height}, ${Math.round(video.fps ?? 0)} fps, ${video.codec ?? '?'}` : 'Off'],
    ['Upload available', formatBitrate(snapshot?.availableOutgoingBps ?? NaN)],
    ...(debug && pacing ? ([['Pacing mode', `${PACING_MODE_COPY[pacing.mode]}${pacing.flowInCharge ? ', in charge' : ''}`]] as Array<[string, string]>) : []),
  ]);
  const p2p = $derived(snapshot ? snapshot.relayedBytes === 0 && !path?.relayed : null);
</script>

<div class="space-y-6">
  {#if p2p !== null}
    <p
      class={[
        'flex gap-3 rounded-[14px] px-4 py-3.5 text-[0.95rem] leading-snug font-bold',
        p2p ? 'bg-[color-mix(in_srgb,var(--color-direct)_12%,var(--color-panel))] text-direct' : 'bg-[color-mix(in_srgb,var(--color-relay)_14%,var(--color-panel))] text-relay',
      ]}
    >
      <span class="mt-0.5 shrink-0"><Icon name={p2p ? 'shield' : 'alert'} size={20} /></span>
      {p2p
        ? 'Peer-to-peer: 0 bytes have gone through any relay. Media and files travel directly between the two devices.'
        : `Relayed: ${formatBytes(snapshot!.relayedBytes)} went through the TURN relay (still end-to-end encrypted).`}
    </p>
  {/if}

  <dl class="tabular divide-y divide-hairline text-[0.95rem]">
    {#each rows as [term, value] (term)}
      <div class="grid grid-cols-[8.5rem_1fr] gap-3 py-2.5">
        <dt class="text-muted">{term}</dt>
        <dd class="min-w-0 font-semibold break-words">{value}</dd>
      </div>
    {/each}
  </dl>

  {#if debug}
    <Button variant="secondary" onclick={onsavetrace}>Save trace</Button>
  {/if}

  {#if safetyWords}
    <section class="rounded-[14px] bg-band p-5 text-band-ink">
      <h3 class="font-extrabold">Safety code</h3>
      <p class="mt-1 text-sm leading-relaxed text-band-muted">Read these words to each other. If they match, nobody is listening in between.</p>
      <p class="mt-4 text-xl font-extrabold tracking-[0.01em] sm:text-2xl">{safetyWords.join(' ')}</p>
    </section>
  {/if}
</div>
