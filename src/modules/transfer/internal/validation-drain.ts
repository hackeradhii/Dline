import type { ControlChannel } from '../../../contracts/ports';
import { Disposer } from '../../../shared/emitter';
import { Timeout, type Clock } from '../../../shared/timer';
import type { DelayEstimator } from './delay-estimator';
import type { FlowController } from './flow-controller';
import type { FlowProbe } from './flow-probe';
import type { FlowTrace } from './flow-trace';
import { LaneBarrier } from './lane-barrier';

interface ValidationDrainDeps {
  controller: Pick<FlowController, 'state' | 'hold' | 'startDrain' | 'endDrain'>;
  estimator: Pick<DelayEstimator, 'cleanFrom' | 'stopCleaning'>;
  probe: Pick<FlowProbe, 'probeNow'>;
  trace: Pick<FlowTrace, 'addDrain'>;
  /** Where the receiver answers each lane's marker. */
  control: ControlChannel;
  clock: Clock;
  /** Puts drain marker `m` behind everything on each open lane; returns those lanes. */
  mark(m: number): number[];
  /** The budget may have changed. */
  changed(): void;
}

/**
 * Rule 6's mechanics (PLAN.md §5.3): hold new writes, put a marker behind everything on every lane,
 * and once every lane has delivered up to its marker, take the next samples as clean; all under the
 * hold's one deadline. The controller decides when to drain and what rate holds before and after.
 */
export class ValidationDrain {
  readonly #barrier: LaneBarrier;
  readonly #deadline: Timeout;
  readonly #disposer = new Disposer();
  #startedAt = 0;

  constructor(private readonly deps: ValidationDrainDeps) {
    this.#barrier = new LaneBarrier(deps.mark);
    this.#deadline = new Timeout(deps.clock);
    const on = this.#disposer.add.bind(this.#disposer);
    on(deps.control.on('flow-mark', ({ m, n }) => this.#barrier.answered(m, n)));
    on(this.#barrier.events.on('passed', () => this.#lanesProvedEmpty()));
    on(this.#barrier.events.on('failed', () => this.end(false)));
  }

  start(at: number): void {
    const { controller, clock } = this.deps;
    controller.startDrain(at);
    const hold = controller.hold;
    if (!hold) return;
    this.#startedAt = at;
    this.#deadline.set(() => this.end(false), hold.until - clock.now());
    this.#barrier.start();
  }

  /** The drain ends: `validated` once a clean sample came, otherwise at its deadline or a lane lost. */
  end(validated: boolean): void {
    const { controller, estimator, clock } = this.deps;
    if (controller.state !== 'draining') return;
    this.#deadline.clear();
    this.#barrier.cancel();
    if (!validated) estimator.stopCleaning();
    const now = clock.now();
    controller.endDrain(validated, now);
    this.deps.trace.addDrain({ start: this.#startedAt, end: now, validated });
    this.deps.changed();
  }

  laneClosed(id: number): void {
    this.#barrier.laneClosed(id);
  }

  dispose(): void {
    this.#disposer.dispose();
    this.#deadline.clear();
  }

  /** Every lane has delivered everything before its marker: probes sent from now on cross an empty path. */
  #lanesProvedEmpty(): void {
    if (this.deps.controller.state !== 'draining') return;
    this.deps.estimator.cleanFrom(this.deps.clock.now());
    this.deps.probe.probeNow();
  }
}
