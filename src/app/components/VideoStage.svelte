<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { RoomState } from '../state/room.svelte';
  import { playStream } from '../view';

  /** Their video fills the stage; your own preview sits in the corner; `children` are the call controls. */
  let { room, children }: { room: RoomState; children: Snippet } = $props();
  const remoteVideoOff = $derived(!room.remoteMedia.video);
  const mirrored = $derived(room.localMedia.video);
</script>

<div class="relative h-[min(68dvh,42rem)] min-h-[22rem] overflow-hidden rounded-[14px] bg-stage">
  <video {@attach playStream(room.remoteStream)} class="h-full w-full object-contain" autoplay playsinline></video>

  {#if remoteVideoOff}
    <div class="absolute inset-0 grid place-items-center px-6 text-center">
      <p class="text-[1.05rem] font-bold text-white/75">{room.callState === 'outgoing' ? 'Calling…' : room.remoteMedia.audio ? 'Their camera is off' : 'Connecting the call…'}</p>
    </div>
  {/if}

  {#if room.localStream}
    <!-- Own preview: small, muted, mirrored like a selfie. -->
    <video
      {@attach playStream(room.localStream)}
      class={['absolute top-3 right-3 aspect-[3/4] w-24 rounded-lg bg-black object-cover shadow-[0_8px_24px_rgb(0_0_0/0.45)] ring-2 ring-white/80 sm:w-32', mirrored && '-scale-x-100']}
      autoplay
      playsinline
      muted
    ></video>
  {/if}

  <div class="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/55 to-transparent px-3 pt-12 pb-4">
    {@render children()}
  </div>
</div>
