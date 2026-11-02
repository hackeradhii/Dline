import { FLOW } from '../../../shared/config';
import { NoiseFloor } from './noise-floor';

/**
 * The queueing-delay target, ms: call first, or the idle target, grown if another app owns the
 * queue (rule 7); and never so low that marking (from half of it) starts inside the path's own noise.
 */
export class QueueTarget {
  /** The path's own queueing delay, from clean samples: marking starts above it. */
  readonly #noise = new NoiseFloor();
  #scale = 1;
  #externalSince: number | null = null;

  /** A clean sample's raw queueing delay (idle, or right after a drain). */
  clean(qdRaw: number, at: number): void {
    this.#noise.add(qdRaw, at);
  }

  noise(at: number): number {
    return this.#noise.value(at);
  }

  value(callActive: boolean, noise: number): number {
    const base = callActive ? FLOW.targetCallMs : FLOW.targetIdleMs * this.#scale;
    return Math.max(base, Math.min(FLOW.noiseTargetMaxMs, FLOW.noiseTargetFactor * noise));
  }

  /** A call starts: the target drops to the call's at once. */
  callStarted(): void {
    this.#scale = 1;
  }

  /**
   * Rule 7 (no call only, SCReAM adjust_qdelay_target): a queue above target that persists while
   * files are `starved` (down to a quarter of their last rate) isn't ours, so the target grows, up
   * to 400 ms; it shrinks back once the queue is under half of it.
   */
  external(qdAvg: number, target: number, starved: boolean, callActive: boolean, step: number, at: number): void {
    if (callActive) {
      this.#scale = 1;
      this.#externalSince = null;
      return;
    }
    if (qdAvg > target && starved) {
      this.#externalSince ??= at;
      if (at - this.#externalSince < FLOW.externalQueueMs) return;
      this.#scale = Math.min(FLOW.targetMaxMs / FLOW.targetIdleMs, this.#scale * FLOW.externalStep);
      this.#externalSince = at;
    } else {
      this.#externalSince = null;
      if (qdAvg < target / 2) this.#scale = Math.max(1, this.#scale * FLOW.externalDecayPerSecond ** (step / 1000));
    }
  }

  reset(): void {
    this.#noise.reset();
    this.#scale = 1;
    this.#externalSince = null;
  }
}
