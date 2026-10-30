import type { Clock, Visibility } from '../timer';

/** Deterministic clock for tests. */
export class FakeClock implements Clock {
  #now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + ms, fn, every: ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Advances time, firing due timers in order. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.#now = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.#timers.delete(id);
      timer.fn();
    }
    this.#now = target;
  }
}

export class FakeVisibility implements Visibility {
  #visible = true;
  readonly #listeners = new Set<(v: boolean) => void>();

  isVisible(): boolean {
    return this.#visible;
  }

  onChange(listener: (visible: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  set(visible: boolean): void {
    this.#visible = visible;
    this.#listeners.forEach((l) => l(visible));
  }
}
