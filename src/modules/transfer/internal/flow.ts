import { FLOW, TRANSFER } from '../../../shared/config';
import { clamp } from '../../../shared/math';
import { alwaysVisible, systemClock, type Clock, type Visibility } from '../../../shared/timer';
import type { ChunkPacing } from './framing';
import type { Actuator } from './pacing-selector';

/**
 * One token bucket for file uploads on every lane. `limit()` is the budget in force: bytes per
 * second, null for none, or 0 to hold (no new block starts until it changes).
 *
 * Two actuators share it (PLAN.md §5.5):
 * - block: tokens for a whole block, and a 100 ms bucket. Today's pacing, kept as it is for the
 *   legacy and shadow modes and for older peers.
 * - fine: tokens per chunk of 1–16 KiB, about 5 ms of the budget, from a bucket of about 10 ms of
 *   it, so a block leaves as an even trickle instead of a burst and a timer that fires a few ms
 *   late costs nothing (the bucket keeps what it owes). In a hidden tab, where timers fire about
 *   once a second, the bucket grows with the gaps between wake-ups (up to 250 ms), and any
 *   `poke()` (an ack, an echo, a lane draining) re-checks it in between.
 */
export class Pacer {
  readonly #meter: SpeedMeter;
  #tokens = 0;
  #last: number;
  #taken = 0;
  /** The last positive budget, so a block that started before a hold can finish. */
  #lastRate = 0;
  #lastWaitAt = -Infinity;
  #hiddenBurstMs: number = FLOW.burstMs;
  #wake: (() => void) | null = null;
  /** The fine actuator, chunk by chunk. */
  readonly #chunks: ChunkPacing = { chunkBytes: (n) => this.chunkBytes(n), beforeChunk: (n) => this.takeChunk(n) };

  constructor(
    private readonly limit: () => number | null,
    private readonly clock: Clock = systemClock,
    private readonly visibility: Visibility = alwaysVisible,
  ) {
    this.#last = clock.now();
    this.#meter = new SpeedMeter(clock);
  }

  /** Actual file upload rate over the last few seconds. */
  get bytesPerSecond(): number {
    return this.#meter.bytesPerSecond;
  }

  /** When the pacer last had to wait for tokens, i.e. the budget, not the app, set the pace. */
  get lastWaitAt(): number {
    return this.#lastWaitAt;
  }

  /** Re-check now: tokens may be due, or the budget has changed. */
  poke(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /**
   * Waits until a block of `bytes` may start under `actuator`, and returns how its chunks are paced
   * (undefined: they go as they are). The fine actuator paces chunk by chunk while there is a budget;
   * otherwise the whole block's tokens are taken here. Either way its header waits out a hold: a
   * drain may have begun while the block waited for its tokens (Flow taking over from legacy, then
   * validating at once), and its markers are already out.
   */
  async admit(bytes: number, actuator: Actuator): Promise<ChunkPacing | undefined> {
    const fine = actuator === 'fine';
    if (fine) await this.startBlock();
    const chunked = fine && this.limit() !== null;
    if (!chunked) await this.takeBlock(bytes);
    if (this.limit() === 0) await this.startBlock();
    return chunked ? this.#chunks : undefined;
  }

  /** Block actuator: waits until a whole block of `bytes` may go. */
  async takeBlock(bytes: number): Promise<void> {
    this.#count(bytes);
    let rate = this.limit();
    while (rate === 0) {
      await this.#sleep(Infinity);
      rate = this.limit();
    }
    if (rate === null) return this.#unpaced();
    const bucket = (rate * TRANSFER.blockBurstMs) / 1000;
    await this.#spend(bytes, rate, bucket, bucket);
  }

  /** Fine actuator, before a block's header goes out: waits out a hold. */
  async startBlock(): Promise<void> {
    while (this.limit() === 0) await this.#sleep(Infinity);
  }

  /** Fine actuator: the size of the next chunk, on a lane that allows `laneChunkBytes`. */
  chunkBytes(laneChunkBytes: number): number {
    const rate = this.#pace();
    if (rate === null) return laneChunkBytes;
    return Math.round(clamp((rate * FLOW.chunkMs) / 1000, FLOW.minPacedChunkBytes, Math.min(FLOW.pacedChunkBytes, laneChunkBytes)));
  }

  /** Fine actuator: waits until the next `bytes` of a started block may go. A hold never stops a started block. */
  async takeChunk(bytes: number): Promise<void> {
    this.#count(bytes);
    const rate = this.#pace();
    if (rate === null) return this.#unpaced();
    const burstMs = this.visibility.isVisible() ? FLOW.burstMs : this.#hiddenBurstMs;
    // One chunk always fits, so sending never deadlocks; and a late wake-up adds nothing beyond the
    // bucket, so no burst is ever larger than it (FLOW-01).
    const bucket = Math.max((rate * burstMs) / 1000, bytes);
    await this.#spend(bytes, rate, bucket, bucket - bytes);
  }

  /** The rate a chunk goes at: the budget, or during a hold the last one (null: unpaced). */
  #pace(): number | null {
    const rate = this.limit();
    if (rate === null) return null;
    return rate > 0 ? rate : this.#lastRate || null;
  }

  #count(bytes: number): void {
    this.#taken += bytes;
    this.#meter.record(this.#taken);
  }

  #unpaced(): void {
    this.#last = this.clock.now();
  }

  /**
   * Takes `bytes` from a bucket that holds at most `bucket`, waiting out any shortfall. `carry` caps
   * what is left over once they are paid for: today's block pacing keeps up to a whole bucket when
   * a timer fires late, so the next block may follow at once.
   */
  async #spend(bytes: number, rate: number, bucket: number, carry: number): Promise<void> {
    this.#lastRate = rate;
    this.#refill(rate, bucket);
    this.#tokens -= bytes;
    while (this.#tokens < 0) {
      this.#lastWaitAt = this.clock.now();
      await this.#sleep((-this.#tokens / rate) * 1000);
      this.#refill(rate, carry);
    }
  }

  #refill(rate: number, bucket: number): void {
    const now = this.clock.now();
    this.#tokens = Math.min(bucket, this.#tokens + ((now - this.#last) / 1000) * rate);
    this.#last = now;
  }

  /** Sleeps `ms` (forever: until poked), or until `poke()`. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const start = this.clock.now();
      let timer: unknown = null;
      const done = (): void => {
        if (timer !== null) this.clock.clearTimeout(timer);
        if (this.#wake === done) this.#wake = null;
        this.#noteWake(this.clock.now() - start, ms);
        resolve();
      };
      this.#wake = done;
      if (Number.isFinite(ms)) timer = this.clock.setTimeout(done, ms);
    });
  }

  /** In a hidden tab, the fine bucket grows to cover how late timers actually fire. */
  #noteWake(sleptMs: number, askedMs: number): void {
    if (this.visibility.isVisible()) this.#hiddenBurstMs = FLOW.burstMs;
    else if (sleptMs > askedMs) this.#hiddenBurstMs = clamp(sleptMs, FLOW.burstMs, FLOW.hiddenBurstMaxMs);
  }
}

/** Sliding-window throughput and time-left estimate, from exact (time, total bytes) pairs. */
export class SpeedMeter {
  readonly #samples: Array<{ t: number; bytes: number }> = [];

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly windowMs: number = TRANSFER.speedWindowMs,
  ) {}

  /** `totalBytes` so far, as of `at` (default: now). */
  record(totalBytes: number, at = this.clock.now()): void {
    const n = this.#samples.length;
    // One kept sample per 100 ms is plenty and keeps this O(1) per chunk. The newest is replaced,
    // time and bytes together, until it is 100 ms clear of the one before it, so pairs stay exact.
    if (n >= 2 && at - this.#samples[n - 2]!.t < TRANSFER.speedSampleGapMs) this.#samples[n - 1] = { t: at, bytes: totalBytes };
    else this.#samples.push({ t: at, bytes: totalBytes });
    while (this.#samples.length > 2 && at - this.#samples[0]!.t > this.windowMs) this.#samples.shift();
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
