import { FLOW, TRANSFER } from '../../../shared/config';

/**
 * A file upload budget (PLAN.md §5.6): bytes/second, null for none, or 0 to hold. Every policy
 * passes one shared contract test (Liskov).
 */
export interface RatePolicy {
  readonly limit: number | null;
}

/** What the call side reports once per stats tick. */
interface CongestionSample {
  callActive: boolean;
  rttMs: number | null;
  /** Inbound packet loss over the last tick, in percent. */
  lossPercent: number | null;
}

/**
 * The legacy policy: keeps file transfers from hurting the video call, without capping them
 * needlessly.
 *
 * Neither the browser's bandwidth estimate nor "quality limited by bandwidth" can size a file cap:
 * both describe the media's own ramp-up and are routinely "limited" at the start of every call.
 * What really hurts a call is a bulk transfer filling the bottleneck queue, which shows up as a
 * growing round trip and as loss. So: AIMD on those signals (back off fast, ramp back quickly),
 * and no limit at all when there is no call.
 */
export class AdaptiveRateLimit implements RatePolicy {
  #limit: number | null = null;
  #baseRttMs = Infinity;

  /** Current upload budget for files in bytes/second, or null for unlimited. */
  get limit(): number | null {
    return this.#limit;
  }

  update(sample: CongestionSample, measuredFileBytesPerSecond: number): void {
    if (!sample.callActive) {
      this.#limit = null;
      this.#baseRttMs = Infinity;
      return;
    }
    if (sample.rttMs !== null) this.#baseRttMs = Math.min(this.#baseRttMs, sample.rttMs);
    const queueing = sample.rttMs !== null && sample.rttMs > this.#baseRttMs * TRANSFER.rttGrowthFactor + TRANSFER.rttSlackMs;
    const lossy = (sample.lossPercent ?? 0) > TRANSFER.lossPercentLimit;

    if (queueing || lossy) {
      const current = this.#limit ?? Math.max(measuredFileBytesPerSecond, TRANSFER.minFileBytesPerSecond);
      this.#limit = Math.max(TRANSFER.minFileBytesPerSecond, current * TRANSFER.backoffFactor);
    } else if (this.#limit !== null) {
      const next = this.#limit * TRANSFER.rampFactor;
      this.#limit = next >= FLOW.unlimitedAboveBytesPerSecond ? null : next;
    }
  }
}
