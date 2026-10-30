<script lang="ts">
  import Button from '../../ui/Button.svelte';
  import Icon from '../../ui/Icon.svelte';
  import { copyText, shareLink } from '../browser';

  let { url, message, label }: { url: string; message: string; label: string } = $props();
  let feedback = $state<string | null>(null);
  let copied = $state(false);

  async function run(action: () => Promise<'shared' | 'copied' | 'failed'>) {
    const result = await action();
    copied = result === 'copied';
    feedback = result === 'copied' ? 'Copied' : result === 'failed' ? 'Could not copy. Select the link and copy it.' : null;
    if (copied)
      setTimeout(() => {
        feedback = null;
        copied = false;
      }, 2000);
  }
</script>

<div class="space-y-2.5">
  <label class="block text-sm font-bold" for="share-{label}">{label}</label>
  <input
    id="share-{label}"
    readonly
    value={url}
    class="tabular w-full truncate rounded-lg border-2 border-hairline bg-panel px-4 py-3 text-sm text-muted focus:border-line focus:outline-none"
    onfocus={(e) => e.currentTarget.select()}
  />
  <div class="flex flex-wrap gap-2">
    <Button variant="primary" onclick={() => run(() => shareLink(url, message))}><Icon name="share" size={18} /> Share</Button>
    <Button onclick={() => run(() => copyText(url))}><Icon name={copied ? 'check' : 'copy'} size={18} /> {copied ? 'Copied' : 'Copy link'}</Button>
  </div>
  <p class={['min-h-5 text-sm text-muted', copied && 'sr-only']} aria-live="polite">{feedback ?? ''}</p>
</div>
