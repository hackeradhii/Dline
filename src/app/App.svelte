<script lang="ts">
  import { displayRoomCode } from '../contracts/room';
  import { detectCapabilities } from '../shared/environment';
  import Notice from '../ui/Notice.svelte';
  import SettingsSheet from './components/SettingsSheet.svelte';
  import { LINK_ERROR_COPY, SERVER_ERROR_COPY } from './copy';
  import Ended from './screens/Ended.svelte';
  import Handoff from './screens/Handoff.svelte';
  import Home from './screens/Home.svelte';
  import Hosting from './screens/Hosting.svelte';
  import LinkInvite from './screens/LinkInvite.svelte';
  import LinkReply from './screens/LinkReply.svelte';
  import Room from './screens/Room.svelte';
  import Waiting from './screens/Waiting.svelte';
  import { Session } from './state/session.svelte';

  const session = new Session();
  const supported = detectCapabilities().webrtc;
  let settingsOpen = $state(false);

  if (supported) {
    void session.handleFragment(location.hash);
    void session.checkNetwork();
  }

  const leave = () => session.leave();
  const openSettings = () => (settingsOpen = true);
  const banner = $derived(
    session.error ?? (session.serverError ? SERVER_ERROR_COPY[session.serverError] : null) ?? (session.linkError && session.screen.name !== 'link-invite' ? LINK_ERROR_COPY[session.linkError] : null),
  );
</script>

<svelte:window onhashchange={() => session.handleFragment(location.hash)} />

{#if !supported}
  <main class="mx-auto max-w-xl px-4 pt-20">
    <h1 class="text-3xl font-extrabold tracking-[-0.02em]">This browser can't make calls</h1>
    <p class="mt-3 text-muted">Dline needs WebRTC. Open this page in a recent Chrome, Safari, Firefox or Edge.</p>
  </main>
{:else}
  {#if banner}
    <div class="fixed inset-x-0 top-0 z-10 mx-auto max-w-xl px-4 pt-4">
      <Notice tone="error" ondismiss={() => session.dismissErrors()}>{banner}</Notice>
    </div>
  {/if}

  {@const screen = session.screen}
  {#if screen.name === 'home'}
    <Home {session} onsettings={openSettings} />
  {:else if screen.name === 'hosting'}
    <Hosting code={screen.code} shareUrl={screen.shareUrl} oncancel={leave} />
  {:else if screen.name === 'joining'}
    <Waiting title="Joining {displayRoomCode(screen.code)}…" oncancel={leave} />
  {:else if screen.name === 'link-invite'}
    <LinkInvite {session} url={screen.url} />
  {:else if screen.name === 'link-reply'}
    <LinkReply url={screen.url} oncancel={leave} />
  {:else if screen.name === 'handoff'}
    <Handoff delivered={screen.delivered} reply={screen.reply} oncancel={leave} />
  {:else if screen.name === 'room' && session.room}
    <Room room={session.room} onleave={leave} />
  {:else if screen.name === 'ended'}
    <Ended reason={screen.reason} causes={screen.causes} onrestart={() => session.startRoom()} onsettings={openSettings} onhome={leave} />
  {/if}

  <SettingsSheet {session} open={settingsOpen} onclose={() => (settingsOpen = false)} />
{/if}
