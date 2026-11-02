import type { ControlChannel } from '../../../contracts/ports';
import { FLOW } from '../../../shared/config';
import { Disposer } from '../../../shared/emitter';
import type { Clock, Visibility } from '../../../shared/timer';
import { DelayEstimator } from './delay-estimator';
import { FeedbackWatch } from './feedback-watch';
import { SpeedMeter } from './flow';
import { FlowController, type FlowDecision, type FlowInputs } from './flow-controller';
import { FlowProbe, type FlowSample } from './flow-probe';
import { FlowResponder } from './flow-responder';
import { FlowTrace } from './flow-trace';
import { HeldProbes } from './held-probes';
import { PacingSelector, type PacingMode } from './pacing-selector';
import { PathRtt } from './path-rtt';
import type { RatePolicy } from './rate-policy';
import { ValidationDrain } from './validation-drain';

/** Inputs from the composition root: the call (as it changes) and the path (per stats tick). */
export interface FlowSessionInputs extends FlowInputs {
  /** Opaque id of the selected candidate pair: a change means a new path. Compared, never stored. */
  pathKey: string | null;
  /** That pair's round trip from ICE, ms: the network's own, which a busy page doesn't inflate. */
  pathRttMs: number | null;
}

/** What diagnostics show (PLAN.md §5.7). */
export interface PacingStatus {
  mode: PacingMode;
  /** Flow sets the pace: flow mode, and a peer that answers. */
  flowInCharge: boolean;
  /** The budget in force: bytes/s, null for none, 0 while holding for a moment. */
  limit: number | null;
  /** The averaged upload queue, ms, from a fresh sample (else null). */
  queueMs: number | null;
  /** The probe round trip, ms, from a fresh sample (else null). */
  pingMs: number | null;
}

interface FlowSessionDeps {
  mode: PacingMode;
  control: ControlChannel;
  /** Today's policy, in force unless Flow is. */
  legacy: RatePolicy;
  /** Monotonic. */
  clock: Clock;
  /** Whether the page is visible: a hidden tab's timers slow to once a second. */
  visibility: Visibility;
  /** Puts drain marker `m` behind everything on each open lane; returns those lanes. */
  mark(m: number): number[];
  /** When the pacer last had to wait for tokens. */
  pacerWaitAt(): number;
  /** Lanes open right now (for the trace). */
  laneCount(): number;
  /** The budget may have changed: let the pacer look again. */
  changed(): void;
}

/**
 * Dline Flow for one connection (PLAN.md §5): probe → estimators → controller → selector, and the
 * trace. Each sample goes through Karn's rule (`HeldProbes`), the delay estimator and the delivery
 * meters to the controller; drains (`ValidationDrain`) and the feedback watch (`FeedbackWatch`) run
 * alongside. The responder answers the peer in every mode; legacy mode runs nothing else.
 */
export class FlowSession {
  readonly responder: FlowResponder;
  readonly selector: PacingSelector;
  readonly trace = new FlowTrace();
  readonly #probe: FlowProbe | null;
  readonly #controller: FlowController | null;
  readonly #drain: ValidationDrain | null;
  readonly #watch: FeedbackWatch | null;
  readonly #estimator = new DelayEstimator();
  readonly #pathRtt = new PathRtt(this.#estimator);
  readonly #held: HeldProbes;
  readonly #delivery: SpeedMeter;
  readonly #recentDelivery: SpeedMeter;
  readonly #disposer = new Disposer();
  #inputs: Omit<FlowSessionInputs, 'pathRttMs'> = { callActive: false, videoOn: false, mediaSendBps: 0, videoCapBps: null, pathKey: null };
  #sending = false;
  #lastWriteAt = -Infinity;
  #lastSample: FlowSample | null = null;

  constructor(private readonly deps: FlowSessionDeps) {
    const { mode, control, clock } = deps;
    this.responder = new FlowResponder(control, clock);
    this.#delivery = new SpeedMeter(clock, FLOW.deliveryWindowMs);
    this.#recentDelivery = new SpeedMeter(clock, FLOW.recentDeliveryWindowMs);
    this.#held = new HeldProbes(deps.visibility);
    const probe = mode === 'legacy' ? null : new FlowProbe(control, clock, () => this.#lastWriteAt, deps.visibility);
    const controller = mode === 'legacy' ? null : new FlowController({ now: () => clock.now(), pacerWaitAt: deps.pacerWaitAt, drains: mode === 'flow' });
    this.#probe = probe;
    this.#controller = controller;
    this.selector = new PacingSelector({ mode, legacy: deps.legacy, flow: controller, probe, clock });
    this.#drain = probe && controller && new ValidationDrain({ controller, estimator: this.#estimator, probe, trace: this.trace, control, clock, mark: deps.mark, changed: deps.changed });
    this.#watch =
      controller &&
      new FeedbackWatch({
        clock,
        gap: () => controller.feedbackGap(),
        silent: (now) => this.#onSilence(now),
        changed: deps.changed,
      });

    if (probe && controller) {
      const on = this.#disposer.add.bind(this.#disposer);
      on(probe.events.on('sample', (s) => this.#onSample(s)));
      on(probe.events.on('capability', (c) => this.#onCapability(c === 'unsupported')));
      on(controller.events.on('decision', (d) => this.#record(d)));
    }
  }

  get status(): PacingStatus {
    const sample = this.#lastSample;
    const fresh = sample !== null && this.deps.clock.now() - sample.at <= FLOW.livePingMs;
    return {
      mode: this.deps.mode,
      flowInCharge: this.selector.flowInCharge,
      limit: this.selector.limit,
      queueMs: fresh ? (this.#controller?.decision?.qdAvgMs ?? null) : null,
      pingMs: fresh ? sample.rttMs : null,
    };
  }

  setInputs(patch: Partial<FlowSessionInputs>): void {
    const { pathKey, pathRttMs, ...call } = patch;
    const now = this.deps.clock.now();
    if (pathKey !== undefined && pathKey !== this.#inputs.pathKey) {
      if (this.#inputs.pathKey !== null) this.#reset(now); // A new path: what was learned about the old one no longer holds.
      this.#inputs = { ...this.#inputs, pathKey };
    }
    if (pathRttMs != null) this.#pathRtt.ice(pathRttMs, now);
    this.#inputs = { ...this.#inputs, ...call };
    this.#controller?.setInputs(call, now);
    this.#tellPathRtt(now);
    this.deps.changed();
  }

  /** Blocks are queued or unacknowledged, or no longer. */
  sending(on: boolean): void {
    if (on === this.#sending) return;
    this.#sending = on;
    this.#held.sending();
    const now = this.deps.clock.now();
    this.#probe?.sending(on);
    this.#controller?.sending(on, now, this.#pathRtt.shortest(now));
    if (!on) this.#watch?.stop();
    else {
      this.#watch?.start(now);
      // Watched from the first byte, not the first echo: the echoes may already have stopped.
      if (this.#probe?.capability === 'supported') this.#watch?.arm(this.#estimator.sRtt ?? 0);
    }
    this.deps.changed();
  }

  /** A block went to a lane. */
  wrote(): void {
    this.#lastWriteAt = this.deps.clock.now();
  }

  acked(): void {
    this.#probe?.acked();
  }

  laneClosed(id: number): void {
    this.#drain?.laneClosed(id);
  }

  dispose(): void {
    this.#disposer.dispose();
    this.#watch?.stop();
    this.#drain?.dispose();
    this.#probe?.dispose();
    this.responder.dispose();
  }

  #onSample(sample: FlowSample): void {
    const controller = this.#controller!;
    const watch = this.#watch!;
    const previous = this.#lastSample;
    this.#lastSample = sample;
    watch.heard(sample.at);
    this.#delivery.record(sample.rxBytes, sample.rxAt);
    this.#recentDelivery.record(sample.rxBytes, sample.rxAt);
    if (this.#sending) this.#held.echo(sample, this.#estimator.sRtt ?? 0);
    if (this.#held.held(sample)) {
      watch.arm(this.#estimator.sRtt ?? 0);
      this.deps.changed();
      return;
    }
    const reading = this.#estimator.add(sample);
    this.#tellPathRtt(sample.at);
    const delivery = { bytesPerSecond: this.#delivery.bytesPerSecond, recentBytesPerSecond: this.#recentDelivery.bytesPerSecond, since: this.#held.since(previous, sample) };
    controller.update(reading, delivery, sample.at);
    if (reading.validated) this.#drain!.end(true);
    else if (controller.wantsDrain(sample.at, this.#estimator.lastCleanAt)) this.#drain!.start(sample.at);
    watch.arm(reading.sRtt);
    this.deps.changed();
  }

  #onCapability(unsupported: boolean): void {
    if (unsupported) this.#reset(this.deps.clock.now());
    this.deps.changed();
  }

  /**
   * A long silence while sending: start over. Sending unlimited, halving does nothing, and with no
   * echo no drain would start. A queue deep enough to hold the echoes back keeps growing then: the
   * drain stops new writes, and if the echoes still don't come it ends in a bounded rate.
   */
  #onSilence(now: number): void {
    this.#reset(now);
    if (this.#controller?.wantsDrain(now, this.#estimator.lastCleanAt)) this.#drain?.start(now);
  }

  /** Files that started before any round trip was known wait for one to choose their start (rule 1). */
  #tellPathRtt(at: number): void {
    const rtt = this.#pathRtt.shortest(at);
    if (rtt !== null) this.#controller?.pathRtt(rtt, at);
  }

  #reset(at: number): void {
    this.#estimator.reset();
    this.#pathRtt.reset();
    this.#controller?.reset(at);
  }

  #record(decision: FlowDecision): void {
    this.trace.add({
      t: decision.at,
      mode: this.deps.mode,
      state: decision.state,
      qd: decision.qdMs,
      qdAvg: decision.qdAvgMs,
      rtt: decision.rttMs,
      delivery: decision.deliveryBytesPerSecond,
      rate: decision.limit,
      legacy: this.deps.legacy.limit,
      applied: this.selector.limit,
      call: this.#inputs.callActive,
      media: this.#inputs.mediaSendBps,
      lanes: this.deps.laneCount(),
      target: decision.targetMs,
      noise: decision.noiseMs,
      reserve: decision.reserveBytesPerSecond,
    });
  }
}
