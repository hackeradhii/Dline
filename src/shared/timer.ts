/** Clock and visibility ports so timing logic is testable and pauses while the page is hidden. */

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

export interface Visibility {
  isVisible(): boolean;
  onChange(listener: (visible: boolean) => void): () => void;
}

export const alwaysVisible: Visibility = {
  isVisible: () => true,
  onChange: () => () => undefined,
};

/**
 * A one-shot timer that only counts down while the page is visible.
 * Phones background the browser while the user is in WhatsApp; that time must not count.
 */
export class VisibleTimer {
  #remaining: number;
  #startedAt = 0;
  #handle: unknown = null;
  readonly #unsubscribe: () => void;

  constructor(
    ms: number,
    private readonly onFire: () => void,
    private readonly clock: Clock = systemClock,
    private readonly visibility: Visibility = alwaysVisible,
  ) {
    this.#remaining = ms;
    this.#unsubscribe = visibility.onChange((visible) => (visible ? this.#resume() : this.#pause()));
    if (visibility.isVisible()) this.#resume();
  }

  cancel(): void {
    this.#pause();
    this.#remaining = Infinity;
    this.#unsubscribe();
  }

  #resume(): void {
    if (this.#handle !== null || !Number.isFinite(this.#remaining)) return;
    this.#startedAt = this.clock.now();
    this.#handle = this.clock.setTimeout(() => {
      this.#handle = null;
      this.cancel();
      this.onFire();
    }, this.#remaining);
  }

  #pause(): void {
    if (this.#handle === null) return;
    this.clock.clearTimeout(this.#handle);
    this.#handle = null;
    this.#remaining = Math.max(0, this.#remaining - (this.clock.now() - this.#startedAt));
  }
}
