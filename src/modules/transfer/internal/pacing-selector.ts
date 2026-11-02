import { FLOW } from '../../../shared/config';
import type { Clock } from '../../../shared/timer';
import type { FlowProbe } from './flow-probe';
import type { RatePolicy } from './rate-policy';

/**
 * Which file pacing runs (PLAN.md §5.6):
 * - legacy: today's behaviour, no probes;
 * - shadow: today's pacing applies, while Flow runs on the probes for diagnostics and the trace;
 * - flow: Flow's budget and fine pacing, once the peer is known to answer.
 */
export type PacingMode = 'legacy' | 'shadow' | 'flow';
export const PACING_MODES: readonly PacingMode[] = ['legacy', 'shadow', 'flow'];

/** How the budget is applied: per block (today's), or per paced chunk (Flow). */
export type Actuator = 'block' | 'fine';

interface PacingSelectorDeps {
  mode: PacingMode;
  legacy: RatePolicy;
  /** Flow's budget (its hold included); null in legacy mode. */
  flow: RatePolicy | null;
  /** Whether the peer answers, and a way to ask it now; null in legacy mode. */
  probe: Pick<FlowProbe, 'capability' | 'probeNow' | 'events'> | null;
  clock: Clock;
}

/**
 * Picks the budget and the actuator. Flow applies only in flow mode with a peer that answered a
 * probe; while that is unknown, and with older peers, today's pacing applies. The scheduler reads
 * the actuator once per block, so a switch only ever happens between blocks.
 */
export class PacingSelector implements RatePolicy {
  #held = false;

  constructor(private readonly deps: PacingSelectorDeps) {}

  get mode(): PacingMode {
    return this.deps.mode;
  }

  get flowInCharge(): boolean {
    return this.deps.mode === 'flow' && this.deps.flow !== null && this.deps.probe?.capability === 'supported';
  }

  get actuator(): Actuator {
    return this.flowInCharge ? 'fine' : 'block';
  }

  get limit(): number | null {
    const flow = this.deps.flow;
    return this.flowInCharge && flow ? flow.limit : this.deps.legacy.limit;
  }

  /**
   * Before the first block (FLOW-03): in flow mode with the peer's answer still pending, probe at
   * once and wait for the first echo, at most `capabilityHoldMs`. About one round trip with a new
   * peer, at most a second with an old one; never again after that, and never in other modes.
   */
  ready(): Promise<void> {
    const probe = this.deps.probe;
    if (this.#held || this.deps.mode !== 'flow' || !probe || probe.capability !== 'unknown') return Promise.resolve();
    this.#held = true;
    probe.probeNow();
    return new Promise((resolve) => {
      const done = (): void => {
        off();
        this.deps.clock.clearTimeout(timer);
        resolve();
      };
      const off = probe.events.on('capability', done);
      const timer = this.deps.clock.setTimeout(done, FLOW.capabilityHoldMs);
    });
  }
}
