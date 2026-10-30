<script lang="ts">
  import type { RoomState } from '../state/room.svelte';
  import Icon, { type IconName } from '../../ui/Icon.svelte';

  let { room }: { room: RoomState } = $props();
  const call = $derived(room.call);

  type Control = { icon: IconName; label: string; pressed?: boolean; danger?: boolean; hidden?: boolean; run: () => unknown };
  const controls = $derived<Control[]>([
    { icon: room.localMedia.audio ? 'mic' : 'mic-off', label: room.localMedia.audio ? 'Mute microphone' : 'Unmute microphone', pressed: !room.localMedia.audio, run: () => call.toggleMic() },
    { icon: room.localMedia.video ? 'camera' : 'camera-off', label: room.localMedia.video ? 'Turn camera off' : 'Turn camera on', pressed: !room.localMedia.video, run: () => call.toggleCamera() },
    { icon: 'flip', label: 'Switch camera', hidden: room.cameraCount < 2 || !room.localMedia.video, run: () => call.flipCamera() },
    { icon: 'phone-off', label: 'End call', danger: true, run: () => call.hangUp() },
  ]);
</script>

<div class="flex items-center gap-3" role="toolbar" aria-label="Call controls">
  {#each controls.filter((c) => !c.hidden) as control (control.icon + control.label)}
    <button
      type="button"
      class={[
        'press grid size-14 place-items-center rounded-full backdrop-blur-md',
        control.danger ? 'w-18 bg-cut text-white hover:bg-cut/90' : control.pressed ? 'bg-white text-stage' : 'bg-white/16 text-white hover:bg-white/26',
      ]}
      aria-label={control.label}
      aria-pressed={control.danger ? undefined : control.pressed}
      onclick={control.run}
    >
      <Icon name={control.icon} />
    </button>
  {/each}
</div>
