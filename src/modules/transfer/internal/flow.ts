import { sleep } from '../../../shared/async';
import { TRANSFER } from '../../../shared/config';
import { systemClock, type Clock } from '../../../shared/timer';

/**
 * Token-bucket rate limiter. `rate()` returns bytes/second, or null for "no limit".
 * Used to leave uplink for the video while a call is running.
 */
export class Pacer {
  #tokens = 0;
  #last: number;
  readonly #meter: SpeedMeter;
  #taken = 0;

  constructor(
    private readonly rate: () => number | null,
    private readonly clock: Clock = systemClock,
  ) {
    this.#last = clock.now();
    this.#meter = new SpeedMeter(clock);
  }

  /** Actual file upload rate over the last few seconds. */
  get bytesPerSecond(): number {
    return this.#meter.bytesPerSecond;
  }

  async take(bytes: number): Promise<void> {
    this.#taken += bytes;
    this.#meter.record(this.#taken);
    const rate = this.rate();
    const now = this.clock.now();
    if (!rate) {
      this.#last = now;
      return;
    }
    // Allow bursts of up to ~100 ms worth of data.
    this.#tokens = Math.min(rate * 0.1, this.#tokens + ((now - this.#last) / 1000) * rate);
    this.#last = now;
    this.#tokens -= bytes;
    if (this.#tokens < 0) await sleep((-this.#tokens / rate) * 1000);
  }
}

/** Sliding-window throughput and time-left estimate. */
export class SpeedMeter {
  readonly #samples: Array<{ t: number; bytes: number }> = [];

  constructor(private readonly clock: Clock = systemClock) {}

  record(totalBytes: number): void {
    const t = this.clock.now();
    const last = this.#samples[this.#samples.length - 1];
    // One sample per 100 ms is plenty for a 3 s window and keeps this O(1) per chunk.
    if (last && t - last.t < 100) {
      last.bytes = totalBytes;
      return;
    }
    this.#samples.push({ t, bytes: totalBytes });
    while (this.#samples.length > 2 && t - this.#samples[0]!.t > TRANSFER.speedWindowMs) this.#samples.shift();
  }

  get bytesPerSecond(): number {
    const first = this.#samples[0];
    const last = this.#samples[this.#samples.length - 1];
    if (!first || !last || last.t === first.t) return 0;
    return ((last.bytes - first.bytes) * 1000) / (last.t - first.t);
  }

  etaMs(remaining: number): number {
    const speed = this.bytesPerSecond;
    return speed > 0 ? (remaining / speed) * 1000 : Infinity;
  }
}
