<script lang="ts">
  import Button from '../../ui/Button.svelte';
  import Notice from '../../ui/Notice.svelte';
  import ShareLink from '../components/ShareLink.svelte';
  import { LINK_ERROR_COPY } from '../copy';
  import type { Session } from '../state/session.svelte';
  import Waiting from './Waiting.svelte';

  let { session, url }: { session: Session; url: string | null } = $props();
  let reply = $state('');
  let applying = $state(false);

  async function connect(event: SubmitEvent) {
    event.preventDefault();
    applying = true;
    await session.applyReply(reply.trim());
    applying = false;
  }
</script>

<Waiting title="Pair with two links" oncancel={() => session.leave()}>
  <ol class="space-y-8">
    <li class="space-y-3">
      <h2 class="text-lg font-extrabold">1. Send them this invite</h2>
      {#if url}
        <ShareLink {url} label="Invite link" message="Open this to connect with me on Dline:" />
      {:else}
        <p class="text-sm text-muted">Preparing your invite…</p>
      {/if}
    </li>
    <li class="space-y-3">
      <h2 class="text-lg font-extrabold">2. Paste the reply they send back</h2>
      <form class="space-y-3" onsubmit={connect}>
        <label class="sr-only" for="reply">Reply link</label>
        <textarea
          id="reply"
          bind:value={reply}
          rows="3"
          placeholder="Paste their reply link here"
          class="tabular w-full rounded-lg border-2 border-hairline bg-panel px-4 py-3 text-sm focus:border-line focus:outline-none"
        ></textarea>
        <Button type="submit" variant="primary" disabled={!reply.trim() || applying}>{applying ? 'Connecting…' : 'Connect'}</Button>
      </form>
      {#if session.linkError}<Notice tone="error">{LINK_ERROR_COPY[session.linkError]}</Notice>{/if}
    </li>
  </ol>
  <p class="text-sm text-muted">Keep this tab open. If you open their reply from WhatsApp in this browser, it is passed to this tab automatically.</p>
</Waiting>
