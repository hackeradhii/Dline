<script lang="ts">
  import type { RoomState } from '../state/room.svelte';
  import Band from '../../ui/Band.svelte';
  import Button from '../../ui/Button.svelte';
  import Icon from '../../ui/Icon.svelte';
  import Line from '../../ui/Line.svelte';
  import Plate from '../../ui/Plate.svelte';
  import Sheet from '../../ui/Sheet.svelte';
  import { formatMs } from '../../shared/format';
  import { lineState, plateTone, statusText } from '../view';
  import DiagnosticsPanel from './DiagnosticsPanel.svelte';

  let { room, onleave }: { room: RoomState; onleave: () => void } = $props();
  let detailsOpen = $state(false);
  const path = $derived(room.snapshot?.path);
  const line = $derived(lineState(room.phase, path));
  // Network-level round trip from ICE; the ctrl heartbeat is only a fallback (it queues behind file data).
  const ping = $derived(room.snapshot?.rttMs ?? room.rtt);
  const moving = $derived(room.transfers.some((t) => t.status === 'transferring'));
</script>

<Band wide>
  {#snippet actions()}<Button variant="band" onclick={onleave}>Leave</Button>{/snippet}
  <button type="button" class="group block w-full rounded-lg text-left" aria-label="Connection details" onclick={() => (detailsOpen = true)}>
    <Line state={line} lanes={room.lanes} {moving} compact />
    <span class="mt-3 flex items-start justify-between gap-4">
      <Plate tone={plateTone(line)} title={statusText(room.phase, path)}>
        {ping !== null ? `, ${formatMs(ping)} ping` : ''}{room.lanes > 1 ? `, ${room.lanes} lanes` : ''}
      </Plate>
      <span class="flex shrink-0 items-center gap-1 text-sm font-bold text-band-muted transition-colors group-hover:text-band-ink">
        Details<Icon name="chevron" size={16} />
      </span>
    </span>
  </button>
</Band>

<Sheet open={detailsOpen} title="Connection" onclose={() => (detailsOpen = false)}>
  <DiagnosticsPanel snapshot={room.snapshot} mode={room.connection.mode} rtt={room.rtt} lanes={room.lanes} safetyWords={room.safetyWords} />
</Sheet>
