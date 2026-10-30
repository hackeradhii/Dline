/** Minimal typed event emitter used by every module (one bus implementation, DRY). */

export type Unsubscribe = () => void;
type Listener<T> = (payload: T) => void;

export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      (listener as Listener<Events[K]>)(payload);
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}

/** Collects unsubscribe/cleanup callbacks so owners can dispose everything at once. */
export class Disposer {
  readonly #fns: Array<() => void> = [];

  add(fn: () => void): void {
    this.#fns.push(fn);
  }

  dispose(): void {
    for (const fn of this.#fns.splice(0).reverse()) {
      try {
        fn();
      } catch {
        // Cleanup must never throw past the owner.
      }
    }
  }
}
