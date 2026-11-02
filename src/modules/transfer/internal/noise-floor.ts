import { FLOW } from '../../../shared/config';

/**
 * The queueing delay a path shows with none of our files on it: radio scheduling, retransmissions,
 * the call's own frames. A queue no larger than this isn't ours to drain, so marking starts above it.
 * Learnt only from clean samples, and as a high percentile of them rather than their peak: one
 * stall would otherwise raise the target for a minute.
 */
export class NoiseFloor {
  readonly #samples: Array<{ qd: number; at: number }> = [];

  add(qd: number, at: number): void {
    this.#samples.push({ qd, at });
    if (this.#samples.length > FLOW.noiseSamples) this.#samples.shift();
  }

  /** The noise in ms, or 0 while there are too few recent clean samples to tell. */
  value(at: number): number {
    while (this.#samples.length && at - this.#samples[0]!.at > FLOW.noiseWindowMs) this.#samples.shift();
    if (this.#samples.length < FLOW.noiseMinSamples) return 0;
    const sorted = this.#samples.map((s) => s.qd).sort((a, b) => a - b);
    return sorted[Math.ceil(FLOW.noisePercentile * sorted.length) - 1]!;
  }

  reset(): void {
    this.#samples.length = 0;
  }
}
