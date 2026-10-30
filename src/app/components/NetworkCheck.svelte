<script lang="ts">
  import type { NetworkProfile } from '../../modules/diagnostics';
  import Plate, { type PlateTone } from '../../ui/Plate.svelte';
  import { VERDICT_COPY } from '../copy';

  /** The pre-flight check as the line's service status, shown on the band. */
  let { profile, checking }: { profile: NetworkProfile | null; checking: boolean } = $props();
  const tone = $derived<PlateTone>(profile?.verdict === 'good' ? 'direct' : profile?.verdict === 'risky' ? 'relay' : 'cut');
  const facts = $derived(
    profile ? [profile.ipv6 ? 'IPv6 available' : 'No IPv6', profile.ipv4 === 'symmetric' ? 'Strict NAT on IPv4' : profile.ipv4 === 'none' ? 'No IPv4 route' : 'Hole-punchable IPv4'] : [],
  );
</script>

<div aria-live="polite">
  {#if checking}
    <Plate tone="idle" flat title="Checking your network…" />
  {:else if profile}
    <Plate {tone} flat title={VERDICT_COPY[profile.verdict].title}>, {facts.join(', ')}</Plate>
    {#if profile.verdict !== 'good'}<p class="mt-2 text-sm leading-relaxed text-band-muted">{VERDICT_COPY[profile.verdict].detail}</p>{/if}
  {/if}
</div>
