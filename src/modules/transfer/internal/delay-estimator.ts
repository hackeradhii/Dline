import { FLOW } from '../../../shared/config';
import { Windowed } from '../../../shared/windowed';
import type { FlowSample } from './flow-probe';

/** What one sample says about the path. */
export interface DelayReading {
  /** Forward queueing delay of this sample after the jitter filter, ms. */
  qd: number;
  /** Averaged queueing delay: drops at once, rises with gain `FLOW.qdGainUp` (SCReAM §4.2.1.4). */
  qdAvg: number;
  /** Smoothed round trip, ms. */
  sRtt: number;
  /** The shortest round trip in the window, ms. */
  baseRtt: number;
  /** A drain's clean samples are in: the base was measured on an empty path. */
  validated: boolean;
}

/**
 * Forward queueing delay from receiver-clocked echoes (LEDBAT-style one-way delay, PLAN.md §5.2):
 * the one-way delay above its windowed minimum. The clocks' offset cancels out; drift over the
 * 60 s window is a few ms. There is deliberately no round-trip cap (FLOW-04): the minimum round
 * trip and minimum one-way delay can come from moments with different reverse-path queues, so a
 * cap could hide a real forward queue.
 *
 * A base built only from loaded samples may include a standing queue, which no reading can tell
 * from an empty path (`qd` is 0 either way). So the estimator records when the base last got a
 * clean sample: one that crossed an empty path, either an idle probe or one sent after a drain
 * proved every lane empty (`cleanFrom`). The controller drains when that is too long ago.
 */
export class DelayEstimator {
  readonly #baseOwd = new Windowed('min', FLOW.baseWindowMs, FLOW.baseBuckets);
  readonly #baseRtt = new Windowed('min', FLOW.baseWindowMs, FLOW.baseBuckets);
  readonly #recent: number[] = [];
  #sRtt: number | null = null;
  #qdAvg = 0;
  #lastCleanAt = -Infinity;
  /** Draining: probes sent at or after this time are clean; null otherwise. */
  #cleanFrom: number | null = null;
  #drainSamples = 0;

  /** When the base last got a clean sample (-Infinity: never since the last reset). */
  get lastCleanAt(): number {
    return this.#lastCleanAt;
  }

  /** Smoothed round trip, or null before the first sample. */
  get sRtt(): number | null {
    return this.#sRtt;
  }

  /** The shortest round trip seen in the window, or null. */
  baseRtt(at: number): number | null {
    return this.#baseRtt.value(at);
  }

  add(sample: FlowSample): DelayReading {
    const { at, rttMs, owdMs } = sample;
    this.#baseOwd.add(owdMs, at);
    this.#baseRtt.add(rttMs, at);
    this.#sRtt = this.#sRtt === null ? rttMs : this.#sRtt + FLOW.rttGain * (rttMs - this.#sRtt);
    const validated = this.#clean(sample);

    this.#recent.push(Math.max(0, owdMs - this.#baseOwd.value(at)!));
    if (this.#recent.length > FLOW.jitterSamples) this.#recent.shift();
    const qd = Math.min(...this.#recent);
    this.#qdAvg = qd < this.#qdAvg ? qd : this.#qdAvg + FLOW.qdGainUp * (qd - this.#qdAvg);
    return { qd, qdAvg: this.#qdAvg, sRtt: this.#sRtt, baseRtt: this.#baseRtt.value(at)!, validated };
  }

  /** A drain proved every lane empty at `at` (on the sender's clock): probes sent from then on are clean. */
  cleanFrom(at: number): void {
    this.#cleanFrom = at;
    this.#drainSamples = 0;
  }

  /** The drain ended without validating the base. */
  stopCleaning(): void {
    this.#cleanFrom = null;
  }

  /** Start over: a new path, a long silence, or a peer that turned out not to answer. */
  reset(): void {
    this.#baseOwd.reset();
    this.#baseRtt.reset();
    this.#recent.length = 0;
    this.#sRtt = null;
    this.#qdAvg = 0;
    this.#lastCleanAt = -Infinity;
    this.#cleanFrom = null;
  }

  /** Notes a clean sample; true when it completes a drain's validation. */
  #clean(sample: FlowSample): boolean {
    const afterDrain = this.#cleanFrom !== null && sample.sentAt >= this.#cleanFrom;
    if (sample.idle) this.#lastCleanAt = sample.at;
    if (!afterDrain) return false;
    // Every clean sample already went into the windowed minimums above; enough of them, a round
    // trip after the lanes were proved empty, validate the base.
    if (++this.#drainSamples < FLOW.drainCleanSamples || sample.at - this.#cleanFrom! < this.#sRtt!) return false;
    this.#cleanFrom = null;
    this.#lastCleanAt = sample.at;
    return true;
  }
}
