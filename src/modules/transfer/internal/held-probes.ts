import { FLOW } from '../../../shared/config';
import type { Visibility } from '../../../shared/timer';
import { feedbackGapMs } from './feedback-watch';
import type { Delivery } from './flow-controller';
import type { FlowSample } from './flow-probe';

/**
 * Karn's rule for probes: `ctrl` is reliable and ordered, so a probe sent before an echo that came
 * late may have waited behind a lost packet's retransmission, and its delay is that wait, not a
 * queue. On the bench, an overflowing 60 ms buffer read as 507 ms that way and cut files to a
 * quarter. A real queue is still there for the probes sent after it.
 */
export class HeldProbes {
  /** Probes sent before this may have waited behind a retransmission. */
  #heldBefore = -Infinity;
  /** When the last echo came while sending (null while not): what a late one is judged against. */
  #lastEchoAt: number | null = null;

  constructor(private readonly visibility: Visibility) {}

  /** Files started or stopped going out. */
  sending(): void {
    this.#lastEchoAt = null;
  }

  /** An echo while sending, with the round trip known before it. */
  echo(sample: FlowSample, sRtt: number): void {
    if (this.#lastEchoAt !== null && sample.at - this.#lastEchoAt >= this.#heldGapMs(sRtt)) this.#heldBefore = sample.at;
    this.#lastEchoAt = sample.at;
  }

  held(sample: FlowSample): boolean {
    return sample.sentAt < this.#heldBefore;
  }

  /** What arrived since the previous echo, unless a held probe, or the wait itself, lies between them. */
  since(previous: FlowSample | null, sample: FlowSample): Delivery['since'] {
    if (!previous || this.held(previous) || sample.rxAt <= previous.rxAt || sample.rxBytes < previous.rxBytes) return null;
    return { bytes: sample.rxBytes - previous.rxBytes, ms: sample.rxAt - previous.rxAt };
  }

  /** How late an echo means `ctrl` may have waited: probes go every 40 ms in a visible tab, while in a hidden one they follow the echoes. */
  #heldGapMs(sRtt: number): number {
    return this.visibility.isVisible() ? FLOW.heldGapProbes * FLOW.probeIntervalMs : feedbackGapMs(sRtt);
  }
}
