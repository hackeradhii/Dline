<script lang="ts">
  import { untrack } from 'svelte';
  import type { Session } from '../state/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Notice from '../../ui/Notice.svelte';
  import Sheet from '../../ui/Sheet.svelte';
  import { SHARE_METRICS_COPY } from '../copy';

  let { session, open, onclose }: { session: Session; open: boolean; onclose: () => void } = $props();

  // The form edits a copy of the saved settings; it is applied only on Save.
  const saved = untrack(() => session.turn);
  let enabled = $state(saved.enabled);
  let urls = $state(saved.urls.join('\n'));
  let username = $state(saved.username);
  let credential = $state(saved.credential);
  let problem = $state<string | null>(null);
  let shareMetrics = $state(untrack(() => session.shareMetrics));

  function save() {
    problem = session.saveTurn({
      enabled,
      urls: urls.split(/[\s,]+/).filter(Boolean),
      username: username.trim(),
      credential,
    });
    if (!problem) onclose();
  }
</script>

<Sheet {open} title="Settings" {onclose}>
  <section class="space-y-3 border-b border-hairline pb-6">
    <h3 class="font-extrabold">Performance stats</h3>
    <label class="flex items-center gap-3 font-bold">
      <input type="checkbox" bind:checked={shareMetrics} onchange={() => session.saveShareMetrics(shareMetrics)} class="size-5" />
      {SHARE_METRICS_COPY.label}
    </label>
    <p class="text-sm text-muted">{SHARE_METRICS_COPY.detail}</p>
  </section>

  <div class="mt-6 space-y-4">
    <h3 class="font-extrabold">Relay (TURN)</h3>
    <p class="text-sm text-muted">
      Off by default. When on, Dline still tries a direct path first and only uses the relay if none exists. Relayed traffic stays
      end-to-end encrypted, but it is <strong class="text-ink">not peer-to-peer</strong>, and the status bar will say so.
    </p>

    <label class="flex items-center gap-3 font-bold">
      <input type="checkbox" bind:checked={enabled} class="size-5" />
      Use a relay when no direct path exists
    </label>

    <label class="block space-y-1 text-sm">
      <span class="font-bold">TURN URLs</span>
      <textarea bind:value={urls} rows="2" placeholder="turns:turn.example.com:443?transport=tcp" class="w-full rounded-lg border-2 border-hairline bg-paper px-4 py-3 text-sm focus:border-line focus:outline-none"></textarea>
    </label>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="block space-y-1 text-sm">
        <span class="font-bold">Username</span>
        <input bind:value={username} autocomplete="off" class="w-full rounded-lg border-2 border-hairline bg-paper px-4 py-3 focus:border-line focus:outline-none" />
      </label>
      <label class="block space-y-1 text-sm">
        <span class="font-bold">Credential</span>
        <input bind:value={credential} type="password" autocomplete="off" class="w-full rounded-lg border-2 border-hairline bg-paper px-4 py-3 focus:border-line focus:outline-none" />
      </label>
    </div>
    <p class="text-xs text-muted">Saved only on this device. Use short-lived credentials (for example from Cloudflare Realtime TURN). Applies to the next connection.</p>

    {#if problem}<Notice tone="error">{problem}</Notice>{/if}
    <Button variant="primary" wide onclick={save}>Save</Button>
  </div>
</Sheet>
