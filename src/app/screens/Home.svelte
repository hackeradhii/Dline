<script lang="ts">
  import { normalizeRoomCode } from '../../contracts/room';
  import { detectInAppBrowser } from '../../shared/environment';
  import Band from '../../ui/Band.svelte';
  import Button from '../../ui/Button.svelte';
  import Icon from '../../ui/Icon.svelte';
  import Line from '../../ui/Line.svelte';
  import Notice from '../../ui/Notice.svelte';
  import NetworkCheck from '../components/NetworkCheck.svelte';
  import { IN_APP_BROWSER_COPY } from '../copy';
  import type { Session } from '../state/session.svelte';

  let { session, onsettings }: { session: Session; onsettings: () => void } = $props();
  let code = $state('');
  let codeError = $state<string | null>(null);
  const inApp = detectInAppBrowser(navigator.userAgent);

  function join(event: SubmitEvent) {
    event.preventDefault();
    const normalized = normalizeRoomCode(code);
    if (!normalized) {
      codeError = 'Codes are 6 letters and digits, like K7M-Q3P.';
      return;
    }
    codeError = null;
    session.joinRoom(normalized);
  }
</script>

<Band>
  {#snippet actions()}
    <Button variant="band" onclick={onsettings} aria-label="Relay settings{session.relayEnabled ? ' (on)' : ''}">
      <Icon name="settings" size={20} />{#if session.relayEnabled}<span class="text-sm">Relay on</span>{/if}
    </Button>
  {/snippet}
  <Line state="idle" />
  <h1 class="mt-8 text-[2.125rem] leading-[1.08] font-extrabold tracking-[-0.025em] text-balance sm:text-[2.5rem]">
    Call and send files straight to one other device.
  </h1>
  <p class="mt-3 max-w-[34rem] text-[1.05rem] leading-relaxed text-band-muted">
    Full-quality photos, videos and any file, plus a video call. No account, no app, and nothing passes through a server.
  </p>
  <div class="mt-6"><NetworkCheck profile={session.network} checking={session.checkingNetwork} /></div>
</Band>

<main class="mx-auto flex max-w-xl flex-col gap-6 px-4 pt-6 pb-10 sm:px-6">
  {#if inApp}<Notice tone="warn">{IN_APP_BROWSER_COPY}</Notice>{/if}

  <section class="lift rounded-[14px] bg-panel p-5 sm:p-6" aria-label="Connect">
    <Button variant="primary" wide onclick={() => session.startRoom()}>Start a line</Button>
    <p class="mt-2.5 text-center text-sm text-muted">You get a code, a QR and a link to send the other person.</p>

    <div class="my-5 flex items-center gap-3 text-sm text-muted" aria-hidden="true">
      <span class="h-px flex-1 bg-hairline"></span>or join theirs<span class="h-px flex-1 bg-hairline"></span>
    </div>

    <form class="flex gap-2" onsubmit={join}>
      <label class="sr-only" for="code">Code from the other person</label>
      <input
        id="code"
        bind:value={code}
        placeholder="Their code, like K7M-Q3P"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        maxlength="9"
        class="tabular min-h-12 min-w-0 flex-1 rounded-lg border-2 border-hairline bg-paper px-4 pt-0.5 text-[1.05rem] font-bold tracking-[0.08em] uppercase transition-colors placeholder:font-normal placeholder:tracking-normal placeholder:text-muted placeholder:normal-case focus:border-line focus:outline-none aria-invalid:border-cut"
        aria-invalid={codeError ? 'true' : undefined}
        aria-describedby={codeError ? 'code-error' : undefined}
      />
      <Button type="submit">Join</Button>
    </form>
    {#if codeError}<p id="code-error" class="mt-2 text-sm font-semibold text-cut">{codeError}</p>{/if}
  </section>

  <section class="space-y-3 text-[0.95rem] leading-relaxed text-muted">
    <p>The code only helps your devices find each other. After that, calls and files go directly between them, encrypted end to end.</p>
    <div class="-mx-3 flex flex-wrap">
      <Button variant="quiet" onclick={() => session.startLinkInvite()}>Pair with links instead (no server at all)</Button>
    </div>
  </section>
</main>
