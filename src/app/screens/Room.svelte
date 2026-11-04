<script lang="ts">
  import Button from '../../ui/Button.svelte';
  import Icon from '../../ui/Icon.svelte';
  import Notice from '../../ui/Notice.svelte';
  import CallControls from '../components/CallControls.svelte';
  import IncomingCall from '../components/IncomingCall.svelte';
  import SessionStats from '../components/SessionStats.svelte';
  import StatusBar from '../components/StatusBar.svelte';
  import TransferList from '../components/TransferList.svelte';
  import VideoStage from '../components/VideoStage.svelte';
  import { CALL_NOTICE_COPY } from '../copy';
  import type { RoomState } from '../state/room.svelte';

  let { room, onleave }: { room: RoomState; onleave: () => void } = $props();
  const inCall = $derived(room.callState === 'active' || room.callState === 'outgoing');
</script>

<svelte:window onbeforeunload={(e) => room.busy && e.preventDefault()} />

<div class="flex min-h-dvh flex-col">
  <StatusBar {room} {onleave} />

  <main class="mx-auto grid w-full max-w-6xl flex-1 content-start gap-x-8 gap-y-7 px-4 pt-5 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_23rem] lg:pt-7">
    <section aria-label="Video call" class="flex min-w-0 flex-col gap-4">
      {#if room.callNotice}
        <Notice tone={room.callNotice === 'ended' ? 'info' : 'warn'} ondismiss={() => room.dismissNotice()}>{CALL_NOTICE_COPY[room.callNotice]}</Notice>
      {/if}

      {#if inCall}
        <VideoStage {room}><CallControls {room} /></VideoStage>
      {:else}
        <!-- The call stage before a call: same ground and frame as the live one, so starting a call only fills it. -->
        <div class="flex min-h-[17rem] flex-col justify-end rounded-[14px] bg-stage p-6 text-white sm:p-8 lg:aspect-video lg:min-h-0">
          <p class="text-[1.75rem] leading-tight font-extrabold tracking-[-0.02em] sm:text-[2rem]">You're connected</p>
          <p class="mt-2 max-w-md leading-relaxed text-white/70">Start a video call, or send photos, videos and files. Both work at the same time.</p>
          <div><Button variant="stage" class="mt-6" onclick={() => room.call.call()}><Icon name="phone" size={18} /> Start video call</Button></div>
        </div>
      {/if}
    </section>

    <div class="flex min-w-0 flex-col gap-7">
      <TransferList {room} />
      <SessionStats {room} />
    </div>
  </main>
</div>

<IncomingCall {room} />
