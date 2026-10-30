/** Browser implementations of the ports the modules depend on (wired only here, in the app layer). */
import type { MediaDevicesPort } from '../contracts/ports';
import type { Unsubscribe } from '../shared/emitter';
import type { Visibility } from '../shared/timer';

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

/** The page URL without the fragment: base for invite/reply links. */
export function pageBaseUrl(): string {
  return `${location.origin}${location.pathname}`;
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
