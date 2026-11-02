/** Browser implementations of the ports the modules depend on (wired only here, in the app layer). */
import type { MediaDevicesPort } from '../contracts/ports';
import { PACING_MODES, type PacingMode } from '../modules/transfer';
import type { Unsubscribe } from '../shared/emitter';
import type { Visibility } from '../shared/timer';

/** Developer switches in the page URL (PLAN.md §5.6). Share links carry them, so both devices match. */
const SWITCH_KEYS = ['pacing', 'debug'] as const;

interface Switches {
  /** The file pacing to run: `?pacing=legacy|shadow|flow`, else this build's default. */
  pacing: PacingMode;
  /** `?debug=1`: the pacing mode and "Save trace" in the connection details. */
  debug: boolean;
}

const asPacing = (value: unknown): PacingMode | undefined => PACING_MODES.find((mode) => mode === value);

/** Read once at startup; unknown values are ignored. Every build defaults to Flow unless VITE_PACING names another mode. */
export const switches: Switches = (() => {
  const params = new URLSearchParams(location.search);
  return { pacing: asPacing(params.get('pacing')) ?? asPacing(import.meta.env.VITE_PACING) ?? 'flow', debug: params.get('debug') === '1' };
})();

export const mediaDevices: MediaDevicesPort = {
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
};

export const pageVisibility: Visibility = {
  isVisible: () => document.visibilityState === 'visible',
  onChange(listener) {
    const handler = (): void => listener(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
};

type NetworkInformationLike = EventTarget & { type?: string };

/** Fires when the device regains or changes network (Wi-Fi ↔ mobile). */
export function onNetworkChange(listener: () => void): Unsubscribe {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  window.addEventListener('online', listener);
  connection?.addEventListener('change', listener);
  return () => {
    window.removeEventListener('online', listener);
    connection?.removeEventListener('change', listener);
  };
}

/** The page URL without the fragment, keeping only the switches: base for room, invite and reply links. */
export function pageBaseUrl(): string {
  const params = new URLSearchParams(location.search);
  const kept = new URLSearchParams();
  for (const key of SWITCH_KEYS) {
    const value = params.get(key);
    if (value !== null) kept.set(key, value);
  }
  const query = kept.toString();
  return `${location.origin}${location.pathname}${query ? `?${query}` : ''}`;
}

/** Removes the handshake from the address bar so a refresh doesn't replay it. */
export function clearFragment(): void {
  history.replaceState(null, '', pageBaseUrl());
}

/** Keeps the screen on during a call or transfer; re-acquired when the tab becomes visible again. */
export class KeepAwake {
  #sentinel: WakeLockSentinel | null = null;
  #wanted = false;
  readonly #offVisibility: Unsubscribe;

  constructor() {
    this.#offVisibility = pageVisibility.onChange((visible) => visible && this.#wanted && void this.#acquire());
  }

  set(wanted: boolean): void {
    this.#wanted = wanted;
    if (wanted) void this.#acquire();
    else void this.#sentinel?.release().catch(() => undefined);
  }

  dispose(): void {
    this.set(false);
    this.#offVisibility();
  }

  async #acquire(): Promise<void> {
    if (!('wakeLock' in navigator) || (this.#sentinel && !this.#sentinel.released)) return;
    try {
      this.#sentinel = await navigator.wakeLock.request('screen');
    } catch {
      // Not allowed (battery saver, background tab): harmless.
    }
  }
}

/** Saves a received file: share sheet on phones (→ Photos/Files), download elsewhere. */
export async function saveFile(blob: Blob, name: string): Promise<void> {
  const file = blob instanceof File ? blob : new File([blob], name, { type: blob.type });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Share sheet for links (WhatsApp, Instagram…), with clipboard as the fallback. Returns what happened. */
export async function shareLink(url: string, text: string): Promise<'shared' | 'copied' | 'failed'> {
  if (navigator.share) {
    try {
      await navigator.share({ text, url });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'failed';
    }
  }
  return copyText(url);
}

export async function copyText(text: string): Promise<'copied' | 'failed'> {
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
