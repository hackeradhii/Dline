<script lang="ts">
  import ShareLink from '../components/ShareLink.svelte';
  import Waiting from './Waiting.svelte';

  let { delivered, reply, oncancel }: { delivered: boolean | null; reply: string; oncancel: () => void } = $props();
</script>

{#if delivered === null}
  <Waiting title="Passing the reply to your other tab…" {oncancel} />
{:else if delivered}
  <Waiting title="Connected in your other tab" {oncancel}>
    <p class="text-muted">Switch back to the tab where you created the invite. You can close this one.</p>
  </Waiting>
{:else}
  <Waiting title="Open this in your original tab" {oncancel}>
    <p class="text-muted">This browser couldn't reach the tab that made the invite. Copy the reply and paste it into the box in that tab.</p>
    <ShareLink url={reply} label="Their reply" message="Dline reply" />
  </Waiting>
{/if}
