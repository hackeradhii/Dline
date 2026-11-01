import { FLOW } from '../../../shared/config';
import { Windowed } from '../../../shared/windowed';
import type { DelayEstimator } from './delay-estimator';

/**
 * The path's shortest round trip, the probes' or ICE's: what tells a near path from a far one
 * (rule 1). ICE's is the network's own, which a busy page doesn't inflate. A probe's also waits for
 * both pages to get to it: on localhost, pages busy setting up lanes made it 25-58 ms, so a first
 * file took the far path's gentle start and arrived at ~60 % of the speed.
 */
export class PathRtt {
  readonly #ice = new Windowed('min', FLOW.baseWindowMs, FLOW.baseBuckets);

  constructor(private readonly probes: Pick<DelayEstimator, 'baseRtt'>) {}

  /** The selected candidate pair's round trip from ICE, ms. */
  ice(rttMs: number, at: number): void {
    this.#ice.add(rttMs, at);
  }

  shortest(at: number): number | null {
    const probes = this.probes.baseRtt(at);
    const ice = this.#ice.value(at);
    if (probes === null || ice === null) return probes ?? ice;
    return Math.min(probes, ice);
  }

  reset(): void {
    this.#ice.reset();
  }
}
