<script lang="ts">
  import type { TransferItem } from '../../modules/transfer';
  import { formatBytes, formatDuration, formatSpeed } from '../../shared/format';
  import Button from '../../ui/Button.svelte';
  import Icon from '../../ui/Icon.svelte';
  import Progress from '../../ui/Progress.svelte';
  import { saveFile } from '../browser';
  import { TRANSFER_ERROR_COPY } from '../copy';
  import { fileTypeLabel, isRunnableFile } from '../view';

  /** One file as a stop on the line: its marker shows where it stands, the text says exactly. */
  let { item, oncancel }: { item: TransferItem; oncancel: (id: string) => void } = $props();

  // Previews only for images and videos; files are never opened automatically.
  const previewKind = $derived(item.file && item.verified ? (item.mime.startsWith('image/') ? 'image' : item.mime.startsWith('video/') ? 'video' : null) : null);
  let previewUrl = $state<string | null>(null);
  let previewFailed = $state(false);
  $effect(() => {
    if (!previewKind || !item.file) return;
    const url = URL.createObjectURL(item.file);
    previewUrl = url;
    return () => URL.revokeObjectURL(url);
  });

  const active = $derived(item.status === 'queued' || item.status === 'transferring' || item.status === 'verifying');
  const broken = $derived(item.status === 'failed' || item.status === 'cancelled');
  const received = $derived(item.direction === 'in' && item.status === 'done' && !!item.file);
  const fraction = $derived(item.size === 0 ? (item.status === 'done' ? 1 : 0) : item.bytes / item.size);
  const detail = $derived.by(() => {
    switch (item.status) {
      case 'queued':
        return item.direction === 'out' ? 'Waiting to send' : 'Waiting to receive';
      case 'transferring':
        return `${item.direction === 'out' ? 'Sending' : 'Receiving'} ${formatBytes(item.bytes)} of ${formatBytes(item.size)}, ${formatSpeed(item.bytesPerSecond)}, ${formatDuration(item.elapsedMs)} so far, ${formatDuration(item.etaMs)} left`;
      case 'verifying':
        return 'Checking the file is intact…';
      case 'done': {
        const verb = item.direction === 'out' ? 'Sent' : 'Received';
        const average = item.elapsedMs > 0 ? `, ${formatSpeed((item.size * 1000) / item.elapsedMs)}` : '';
        return `${verb} ${formatBytes(item.size)} in ${formatDuration(item.elapsedMs)}${average}, verified with SHA-256`;
      }
      case 'cancelled':
        return 'Cancelled';
      default:
        return item.error ? TRANSFER_ERROR_COPY[item.error] : 'Failed';
    }
  });
</script>

<li class="relative space-y-3 pb-6 pl-9 last:pb-1">
  <span
    class={[
      'absolute top-0.5 left-0 grid size-[22px] place-items-center rounded-full',
      active && 'bg-panel ring-[5px] ring-line ring-inset',
      item.status === 'done' && 'bg-line text-line-ink',
      broken && 'bg-panel ring-[5px] ring-cut ring-inset',
    ]}
    aria-hidden="true"
  >
    {#if item.status === 'done'}<Icon name="check" size={13} />{:else if active}<span class="text-line"><Icon name={item.direction === 'out' ? 'send' : 'download'} size={11} /></span>{/if}
  </span>

  <div class="flex items-start gap-3">
    <div class="min-w-0 flex-1">
      <p class="truncate text-[1.0625rem] font-extrabold">{item.name}</p>
      <p class={['tabular mt-0.5 text-sm leading-snug', item.status === 'failed' ? 'font-semibold text-cut' : 'text-muted']}>{detail}</p>
    </div>
    {#if active}
      <button type="button" class="press -m-1 shrink-0 rounded-lg p-1.5 text-muted hover:bg-cut/10 hover:text-cut" aria-label="Cancel {item.name}" onclick={() => oncancel(item.id)}>
        <Icon name="close" size={18} />
      </button>
    {/if}
  </div>

  {#if active}
    <Progress value={fraction} label="{item.name} progress" />
  {/if}

  {#if previewUrl && previewKind === 'image' && !previewFailed}
    <img src={previewUrl} alt={item.name} class="max-h-72 rounded-lg bg-hairline/50 object-contain" onerror={() => (previewFailed = true)} />
  {:else if previewUrl && previewKind === 'video' && !previewFailed}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video src={previewUrl} controls playsinline class="max-h-72 w-full rounded-lg bg-stage" onerror={() => (previewFailed = true)}></video>
  {:else if received}
    <div class="flex items-center gap-3 rounded-lg bg-panel px-4 py-3 ring-1 ring-hairline">
      <span class="text-line"><Icon name="file" size={26} /></span>
      <span class="text-sm font-extrabold">{fileTypeLabel(item.name)}</span>
      <span class="tabular ml-auto text-sm text-muted">{formatBytes(item.size)}</span>
    </div>
  {/if}

  {#if received && isRunnableFile(item.name)}
    <p class="flex gap-2 text-sm leading-snug font-semibold text-relay"><Icon name="alert" size={17} />This file can run programs. Only open it if you trust the person who sent it.</p>
  {/if}

  {#if received}
    <Button onclick={() => saveFile(item.file!, item.name)}><Icon name="download" size={18} /> Save</Button>
  {/if}
</li>
