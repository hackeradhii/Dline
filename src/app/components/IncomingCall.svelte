<script lang="ts">
  import type { RoomState } from '../state/room.svelte';
  import Button from '../../ui/Button.svelte';
  import Icon from '../../ui/Icon.svelte';
  import Sheet from '../../ui/Sheet.svelte';

  let { room }: { room: RoomState } = $props();
</script>

<Sheet open={room.callState === 'incoming'} title="Incoming video call" onclose={() => room.call.decline()}>
  <div class="flex items-center gap-4">
    <span class="ringing relative grid size-14 shrink-0 place-items-center rounded-full bg-line text-line-ink" aria-hidden="true"><Icon name="phone" /></span>
    <p class="leading-relaxed text-muted">They want to start a video call. Your camera and microphone turn on when you accept.</p>
  </div>
  <div class="mt-6 grid grid-cols-2 gap-3">
    <Button variant="danger" onclick={() => room.call.decline()}><Icon name="phone-off" size={18} /> Decline</Button>
    <Button variant="primary" autofocus onclick={() => room.call.accept()}><Icon name="phone" size={18} /> Accept</Button>
  </div>
</Sheet>

<style>
  /* The one looping motion here: it is ringing until you answer. */
  .ringing::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-line) 45%, transparent);
    animation: ring 1.4s var(--ease-out) infinite;
  }
  @keyframes ring {
    to {
      box-shadow: 0 0 0 16px transparent;
    }
  }
</style>
