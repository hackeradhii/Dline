/**
 * The smallest or largest value seen over a sliding window, or the total, kept in a few time
 * buckets: constant memory, and old values age out one bucket at a time. Used for base delays
 * (min), the start's bound (max) and the bottleneck's busy time and what it carried (sum).
 */
export class Windowed {
  readonly #buckets: Array<{ index: number; value: number }> = [];
  readonly #width: number;

  constructor(
    private readonly kind: 'min' | 'max' | 'sum',
    windowMs: number,
    private readonly buckets: number,
  ) {
    this.#width = windowMs / buckets;
  }

  add(value: number, at: number): void {
    const index = Math.floor(at / this.#width);
    const last = this.#buckets.at(-1);
    if (last?.index === index) last.value = this.#pick(last.value, value);
    else this.#buckets.push({ index, value });
    this.#expire(index);
  }

  /** The extreme (or total) over the window ending at `at`, or null if the window is empty. */
  value(at: number): number | null {
    this.#expire(Math.floor(at / this.#width));
    let best: number | null = null;
    for (const bucket of this.#buckets) best = best === null ? bucket.value : this.#pick(best, bucket.value);
    return best;
  }

  reset(): void {
    this.#buckets.length = 0;
  }

  #pick(a: number, b: number): number {
    if (this.kind === 'sum') return a + b;
    return this.kind === 'min' ? Math.min(a, b) : Math.max(a, b);
  }

  #expire(current: number): void {
    while (this.#buckets.length && this.#buckets[0]!.index <= current - this.buckets) this.#buckets.shift();
  }
}
