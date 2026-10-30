<script lang="ts">
  import ShareLink from '../components/ShareLink.svelte';
  import Waiting from './Waiting.svelte';

  let { url, oncancel }: { url: string | null; oncancel: () => void } = $props();
</script>

<Waiting title="Send this reply back" {oncancel}>
  {#if url}
    <ShareLink {url} label="Reply link" message="Here's my Dline reply, open it to connect:" />
    <p class="text-muted">You'll connect as soon as they open it. After sending, come back to this tab and keep it open.</p>
  {:else}
    <p class="text-muted">Preparing your reply…</p>
  {/if}
</Waiting>
