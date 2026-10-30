<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  /** Modal sheet on a native <dialog>: focus trapping, Esc to close and the backdrop come for free. */
  let { open, title, onclose, children }: { open: boolean; title: string; onclose: () => void; children: Snippet } = $props();

  function sync(dialog: HTMLDialogElement) {
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }
</script>

<dialog
  {@attach sync}
  class="sheet m-auto max-h-[min(92dvh,48rem)] w-[min(34rem,calc(100%-2rem))] overflow-y-auto rounded-[16px] bg-panel p-0 text-ink shadow-2xl max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none"
  aria-label={title}
  onclose={onclose}
  onclick={(e) => e.target === e.currentTarget && onclose()}
>
  <div class="sticky top-0 z-10 flex items-center justify-between gap-4 bg-panel px-6 pt-5 pb-2">
    <h2 class="text-[1.375rem] font-extrabold tracking-[-0.01em]">{title}</h2>
    <button type="button" class="press -mr-2 rounded-lg p-2 text-muted hover:bg-ink/5 hover:text-ink" aria-label="Close" onclick={onclose}>
      <Icon name="close" />
    </button>
  </div>
  <div class="px-6 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
    {@render children()}
  </div>
</dialog>

<style>
  .sheet {
    transition:
      opacity 220ms var(--ease-out),
      transform 260ms var(--ease-drawer),
      overlay 260ms allow-discrete,
      display 260ms allow-discrete;
  }
  .sheet:not([open]) {
    opacity: 0;
    transform: translateY(12px) scale(0.98);
  }
  @starting-style {
    .sheet[open] {
      opacity: 0;
      transform: translateY(12px) scale(0.98);
    }
  }
  @media (max-width: 639px) {
    .sheet:not([open]) {
      opacity: 1;
      transform: translateY(100%);
    }
    @starting-style {
      .sheet[open] {
        opacity: 1;
        transform: translateY(100%);
      }
    }
  }
  .sheet::backdrop {
    background: rgb(11 11 31 / 0.55);
    transition:
      opacity 220ms ease,
      overlay 260ms allow-discrete,
      display 260ms allow-discrete;
  }
  .sheet:not([open])::backdrop {
    opacity: 0;
  }
  @starting-style {
    .sheet[open]::backdrop {
      opacity: 0;
    }
  }
</style>
