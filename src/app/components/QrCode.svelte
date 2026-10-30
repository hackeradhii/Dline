<script lang="ts">
  let { text, label }: { text: string; label: string } = $props();

  // Loaded on demand: only the host's waiting screen needs a QR code. Generated locally from our own URL.
  const svg = $derived(import('uqr').then(({ renderSVG }) => renderSVG(text, { border: 2, whiteColor: '#ffffff', blackColor: '#1b1b3a' })));
</script>

<figure class="aspect-square w-40 shrink-0 justify-self-center overflow-hidden rounded-lg bg-white p-1 ring-1 ring-hairline sm:w-36" aria-label={label}>
  {#await svg then markup}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html markup}
  {/await}
</figure>

<style>
  figure :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
</style>
