<script lang="ts">
  import type { RoomState } from '../state/room.svelte';
  import Button from '../../ui/Button.svelte';
  import Icon from '../../ui/Icon.svelte';
  import TransferRow from './TransferRow.svelte';

  /** Files as stops along the line, newest first. Files can also be dropped anywhere on this column. */
  let { room }: { room: RoomState } = $props();
  let picker: HTMLInputElement;
  let dragging = $state(false);
  const newestFirst = $derived([...room.transfers].reverse());

  function send(files: FileList | null | undefined) {
    if (files?.length) room.files.send(files);
  }

  function pick(event: Event & { currentTarget: HTMLInputElement }) {
    send(event.currentTarget.files);
    event.currentTarget.value = '';
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    send(event.dataTransfer?.files);
  }

  function over(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragging = true;
  }

  function leave(event: DragEvent & { currentTarget: HTMLElement }) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dragging = false;
  }
</script>

<section
  aria-labelledby="files-title"
  class={['-m-2 rounded-[16px] p-2 transition-[background-color,box-shadow] duration-200', dragging && 'bg-line/8 ring-2 ring-line']}
  ondragover={over}
  ondragleave={leave}
  ondrop={drop}
>
  <div class="flex items-center justify-between gap-3">
    <h2 id="files-title" class="text-[1.375rem] font-extrabold tracking-[-0.01em]">Files</h2>
    <input bind:this={picker} type="file" multiple class="sr-only" tabindex="-1" aria-hidden="true" onchange={pick} />
    <Button onclick={() => picker.click()}><Icon name="send" size={18} /> Send files</Button>
  </div>

  {#if newestFirst.length === 0}
    <div class="relative mt-5 pl-9">
      <span class="absolute top-1 bottom-1 left-[9px] w-1 rounded-full bg-[repeating-linear-gradient(180deg,var(--color-hairline)_0_8px,transparent_8px_14px)]" aria-hidden="true"></span>
      <p class="font-bold">Nothing sent yet</p>
      <p class="mt-1 text-[0.95rem] leading-relaxed text-muted">
        Photos, videos and any other file go straight to the other device at full quality, and every piece is checked on arrival.
        <span class="max-lg:hidden">You can also drop files here.</span>
      </p>
    </div>
  {:else}
    <ul class="relative mt-5 before:absolute before:top-3 before:bottom-3 before:left-[9px] before:w-1 before:rounded-full before:bg-line">
      {#each newestFirst as item (item.id)}
        <TransferRow {item} oncancel={(id) => room.files.cancel(id)} />
      {/each}
    </ul>
  {/if}
</section>
