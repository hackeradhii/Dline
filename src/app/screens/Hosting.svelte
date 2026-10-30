<script lang="ts">
  import { displayRoomCode } from '../../contracts/room';
  import QrCode from '../components/QrCode.svelte';
  import ShareLink from '../components/ShareLink.svelte';
  import Waiting from './Waiting.svelte';

  let { code, shareUrl, oncancel }: { code: string; shareUrl: string; oncancel: () => void } = $props();
</script>

<Waiting title="Waiting for them to join" {oncancel}>
  <section class="lift grid items-center gap-5 rounded-[14px] bg-panel p-5 sm:grid-cols-[1fr_auto] sm:p-6" aria-label="Your code">
    <div>
      <p class="text-sm font-bold text-muted">Your code</p>
      <p class="tabular mt-1 text-[2.75rem] leading-none font-extrabold tracking-[0.06em] sm:text-[3.25rem]">{displayRoomCode(code)}</p>
      <p class="mt-3 text-sm leading-relaxed text-muted">They type it on the Dline home screen, or scan the QR with their camera.</p>
    </div>
    <QrCode text={shareUrl} label="QR code to join this line" />
  </section>
  <ShareLink url={shareUrl} label="Or send this link" message="Join my Dline call:" />
  <p class="text-sm leading-relaxed text-muted">Keep this tab open. The code works once, for one person, for the next 10 minutes.</p>
</Waiting>
