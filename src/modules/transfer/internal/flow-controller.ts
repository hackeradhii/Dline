import { FLOW, LANES } from '../../../shared/config';
import { Emitter } from '../../../shared/emitter';
import { clamp } from '../../../shared/math';
import { Windowed } from '../../../shared/windowed';
import { CallGuard, type CallInputs } from './call-guard';
import { DrainSchedule, type Drain } from './drain-schedule';
import type { DelayReading } from './delay-estimator';
import { QueueTarget } from './queue-target';
import type { RatePolicy } from './rate-policy';

/**
 * - unlimited: no budget, exactly today's behaviour: on a near path until a queue appears, and
 *   on any path once the budget grew past what a link carries.
 * - controlled: the budget is the rate R.
 * - draining: a short hold that proves the base delay was measured on an empty path (rule 6).
 */
export type FlowState = 'unlimited' | 'controlled' | 'draining';

/** Plain inputs from the composition root (see `CallInputs`). */
export type FlowInputs = CallInputs;

/** What the receiver reports arriving. */
export interface Delivery {
  /** Bytes/s over `FLOW.deliveryWindowMs`: what the rate decisions use. */
  bytesPerSecond: number;
  /** Bytes/s over `FLOW.recentDeliveryWindowMs`, without the longer window's lag behind a ramp: what bounds a gentle start. */
  recentBytesPerSecond: number;
  /** Bytes that arrived since the previous echo, over how long (the receiver's clock); null when there is no previous one. */
  since: { bytes: number; ms: number } | null;
}

/** A drain's hold on new writes and its deadline, past which `limit` releases it by itself (FLOW-13). */
interface Hold {
  until: number;
  /** The positive budget once the hold is released without validating the base. */
  release: number;
}

/** One decision, per sample: what it saw and the budget it set. */
export interface FlowDecision {
  at: number;
  state: FlowState;
  /** Bytes/s, null for none, 0 while draining. */
  limit: number | null;
  qdMs: number;
  qdAvgMs: number;
  rttMs: number;
  deliveryBytesPerSecond: number;
  targetMs: number;
  /** The path's own queueing delay, from clean samples (0 while unknown). */
  noiseMs: number;
  /** What the call keeps, while a call is on, the bottleneck is known and the path is quiet enough to measure it. */
  reserveBytesPerSecond: number | null;
}

interface FlowControllerOptions {
  /** Monotonic: what a hold's deadline is checked against. */
  now(): number;
  /** When the pacer last had to wait: the budget is actually in use. */
  pacerWaitAt(): number;
  /** Validation drains are allowed (Flow in charge); never in shadow mode. */
  drains: boolean;
}

/** No budget below the floor. */
const floored = (rate: number): number => Math.max(FLOW.minBytesPerSecond, rate);

/** Just under what is actually arriving, so any queue already built drains straight away. */
const entryRate = (delivery: number): number => floored(FLOW.entryFactor * delivery);

/**
 * Rate decisions only (PLAN.md §5.3): a queue-target controller over the whole bundle of lanes,
 * after SCReAM v2's virtual L4S. Queueing delay above half the target becomes a marking fraction
 * α, and the rate is cut by α/2 per round trip; it regrows carefully near the last congestion
 * point and quickly far from it. SCTP's own congestion control stays underneath as the inner loop.
 */
export class FlowController implements RatePolicy {
  readonly events = new Emitter<{ decision: FlowDecision }>();
  readonly #guard = new CallGuard();
  readonly #target = new QueueTarget();
  /** The most that arrived lately (`FLOW.startDeliveryWindowMs`): what bounds a gentle start. */
  readonly #peakDelivery = new Windowed('max', FLOW.startDeliveryWindowMs, FLOW.startDeliveryBuckets);
  #state: FlowState = 'unlimited';
  /** R, bytes/s: the budget while controlled. */
  #rate = 0;
  /** R_last: the rate at the last congestion point; null when unknown. */
  #rateLast: number | null = null;
  #marked = false;
  #lastAt: number | null = null;
  #delivery = 0;
  #sendingSince: number | null = null;
  #inputs: FlowInputs = { callActive: false, videoOn: false, mediaSendBps: 0, videoCapBps: null };
  readonly #drains: DrainSchedule;
  /** Files started before any round trip was known: rule 1 waits for the first. */
  #startPending = false;
  #decision: FlowDecision | null = null;

  constructor(private readonly options: FlowControllerOptions) {
    this.#drains = new DrainSchedule(options.drains);
  }

  get limit(): number | null {
    const drain = this.#drains.active;
    // A hold never outlives its deadline, whatever is late to end the drain (FLOW-13).
    if (drain) return this.options.now() >= drain.until ? this.#release(drain) : 0;
    return this.#state === 'unlimited' ? null : this.#rate;
  }

  get state(): FlowState {
    return this.#state;
  }

  get hold(): Hold | null {
    const drain = this.#drains.active;
    return drain && { until: drain.until, release: this.#release(drain) };
  }

  /** The latest decision, or null before the first sample. */
  get decision(): FlowDecision | null {
    return this.#decision;
  }

  setInputs(patch: Partial<FlowInputs>, at: number): void {
    const starting = !this.#inputs.callActive && patch.callActive === true;
    this.#inputs = { ...this.#inputs, ...patch };
    if (!starting) return;
    // A call starts: the target drops to the call's at once (the next sample uses it), and with a
    // known bottleneck the call gets its share straight away, so its video starts on an empty queue.
    this.#target.callStarted();
    const room = this.#room(at);
    if (room === null || this.#state === 'draining') return;
    if (this.#state === 'unlimited') this.#control(room, null);
    else this.#rate = Math.min(this.#rate, room);
  }

  /** Files started (or stopped) going out. `baseRttMs` is the path's shortest round trip, if known. */
  sending(on: boolean, at: number, baseRttMs: number | null): void {
    if (!on) {
      this.#sendingSince = null;
      this.#startPending = false;
      return;
    }
    if (this.#sendingSince !== null) return;
    this.#sendingSince = at;
    this.#start(baseRttMs, at);
  }

  /** The path's shortest round trip, as it becomes known while sending: rule 1 decides once there is one. */
  pathRtt(baseRttMs: number, at: number): void {
    if (this.#startPending) this.#start(baseRttMs, at);
  }

  update(reading: DelayReading, delivery: Delivery, at: number): void {
    const step = clamp(at - (this.#lastAt ?? at - FLOW.probeIntervalMs), FLOW.stepMinMs, FLOW.stepMaxMs);
    this.#lastAt = at;
    this.#delivery = delivery.bytesPerSecond;
    this.#peakDelivery.add(delivery.recentBytesPerSecond, at);
    const rtt = Math.max(reading.sRtt, FLOW.virtualRttMs);
    if (reading.clean) this.#target.clean(reading.qdRaw, at);
    const noise = this.#target.noise(at);
    const target = this.#target.value(this.#inputs.callActive, noise);
    const alpha = clamp((reading.qdAvg - target / 2) / (target / 2), 0, 1);
    const { mediaSendBps } = this.#inputs;
    this.#guard.observe({ qd: reading.qd, since: delivery.since, deliveryKnown: this.#deliveryKnown(at), target, noise, mediaSendBps }, at);

    if (this.#state !== 'draining' && this.#sendingSince !== null) {
      if (this.#state === 'unlimited') this.#maybeEnter(alpha, at);
      // Cuts go just under what arrives, so they wait for a full delivery reading, as rule 1 does: a
      // mark 300 ms into a gentle start, with nothing arrived yet, cut to the floor (field, 2026-11-02).
      else if (alpha === 0 || this.#deliveryKnown(at)) this.#adjust(alpha, reading.qdAvg, target, step, rtt, at);
      // A known call reserve doesn't depend on that reading: it holds from the first sample (RESERVE-07).
      else this.#capForCall(at);
      const starved = this.#state === 'controlled' && this.#rateLast !== null && this.#rate <= FLOW.externalStarvedShare * this.#rateLast;
      this.#target.external(reading.qdAvg, target, starved, this.#inputs.callActive, step, at);
    }
    this.#decide(at, reading, target, noise);
  }

  /** Rule 8: no echo for a while during a controlled transfer halves the rate, once per gap. */
  feedbackGap(): void {
    if (this.#sendingSince === null || this.#state !== 'controlled') return;
    this.#rate = floored(this.#rate / 2);
  }

  /** The estimates start over (new path, long silence): forget what was learned about the path. */
  reset(at: number): void {
    this.#lastAt = null;
    this.#marked = false;
    this.#target.reset();
    this.#guard.reset();
    this.#peakDelivery.reset();
    // While sending, the new base may be measured over a standing queue; idle probes are clean anyway.
    this.#drains.suspect(this.#sendingSince !== null ? at : null);
  }

  /** Rule 6: time to prove the base was measured on an empty path. */
  wantsDrain(at: number, lastCleanAt: number): boolean {
    return this.#drains.due(at, lastCleanAt, this.#sendingSince);
  }

  /** Rule 6, step 1: hold new writes, for at most `drainMaxMs` in all. */
  startDrain(at: number): void {
    if (this.#state === 'draining') return;
    this.#drains.begin(this.#state, this.#rate, this.#delivery, at);
    this.#state = 'draining';
  }

  /**
   * The drain ended: validated, it returns to where it was; otherwise nothing is certified and the
   * hold is released to a positive rate (controlled keeps its rate, unlimited stops sending
   * unlimited), with another attempt after `drainRetryMs`.
   */
  endDrain(validated: boolean, at: number): void {
    const drain = this.#drains.finish(validated, at);
    if (!drain) return;
    if (validated) {
      this.#state = drain.from;
      this.#rate = drain.rate;
      return;
    }
    this.#control(this.#release(drain), drain.from === 'controlled' ? this.#rateLast : drain.delivery);
  }

  #release(drain: Drain): number {
    return drain.from === 'controlled' ? drain.rate : entryRate(drain.delivery);
  }

  /**
   * Rule 1: with the bottleneck unknown on a far path, start gently and grow, instead of
   * unlimited. Unlimited, the lanes' slow start commits seconds of data before the first mark
   * can stop it: on the bench that alone filled a 3 s buffer for 4 s, call or not. Near paths
   * (LAN, localhost) start unlimited: there the ramp would cost more than it saves. With no round
   * trip known yet (files picked as the devices connect, or just after a new path), the first one decides.
   */
  #start(baseRttMs: number | null, at: number): void {
    this.#startPending = baseRttMs === null;
    const far = baseRttMs !== null && baseRttMs > LANES.nearRttMs;
    if (this.#state === 'unlimited' && far && this.#guard.measured(at) === null) this.#control(this.#startRate(), null);
  }

  #control(rate: number, rateLast: number | null): void {
    this.#state = 'controlled';
    this.#rate = rate;
    this.#rateLast = rateLast;
  }

  /** Rule 1: the first mark, once files have been going long enough for a full delivery reading. */
  #maybeEnter(alpha: number, at: number): void {
    if (alpha === 0 || at - this.#sendingSince! < FLOW.deliveryWindowMs) return;
    this.#control(entryRate(this.#delivery), this.#delivery);
    this.#marked = true;
    this.#capForCall(at);
  }

  #adjust(alpha: number, qdAvg: number, target: number, step: number, rtt: number, at: number): void {
    if (alpha > 0) {
      // Rule 2: cut in proportion to the marking, at most α/2 per round trip (DCTCP / SCReAM).
      // The last congestion point is what the link carried, which a too-high rate overstates. Out
      // of a gentle start, what arrives still lags the ramp, so the link carried its recent peak:
      // the lagging reading set it a third low on the bench, and growth near it was careful from there.
      if (!this.#marked) {
        const carried = this.#rateLast === null ? Math.max(this.#delivery, this.#peakDelivery.value(at) ?? 0) : this.#delivery;
        this.#rateLast = Math.min(this.#rate, carried);
        this.#rate = Math.min(this.#rate, entryRate(this.#delivery));
      }
      // Bytes already handed to the lanes keep arriving for a while after a cut, so the queue answers
      // late. Cuts stop at α/2 below what the link delivers, which already drains the queue: cutting
      // on through that delay would wind the rate down to the floor (seen in simulation). A rate
      // below that (after a deep cut) comes back up to it as the queue falls.
      const drain = (1 - alpha / 2) * this.#delivery;
      if (this.#rate > drain) this.#rate = Math.max(drain, this.#rate * (1 - (alpha / 2) * Math.min(1, step / rtt)));
      else this.#rate = Math.max(this.#rate, Math.min(drain, FLOW.entryFactor * this.#delivery));
      // A deep queue (the link suddenly slowed): drain it at ~3/4 of the link now, not over round trips the queue itself inflates.
      if (qdAvg > FLOW.deepQueueTargets * target) this.#rate = Math.min(this.#rate, FLOW.deepFactor * this.#delivery);
      this.#rate = floored(this.#rate);
      this.#marked = true;
    } else {
      this.#marked = false;
      // Rule 3: grow only while the budget is in use (cwnd validation), so it can't balloon while idle.
      if (at - this.options.pacerWaitAt() <= FLOW.usedWithinRtts * rtt) this.#grow(step, rtt, at);
    }
    // Rule 4: back to unlimited once the budget is far above anything a link carries.
    if (this.#rate >= FLOW.unlimitedAboveBytesPerSecond) {
      this.#state = 'unlimited';
      this.#rateLast = null;
    } else this.#capForCall(at);
  }

  /**
   * Quick far below the last congestion point, careful near it (SCReAM scl_t), and careful above
   * it: the queue is seen only a few samples late, and quick growth past the link's known capacity
   * would double the rate in that time (seen in simulation). With no congestion point yet (a
   * gentle start), growth can't outrun what arrives, at its recent peak: a full link delivers no
   * more than it carries, so until the first mark is in, the queue builds at most
   * (`startDeliveryGain` - 1) of the link.
   */
  #grow(step: number, rtt: number, at: number): void {
    const last = this.#rateLast;
    const distance = last === null ? 1 : this.#rate >= last ? 0 : ((FLOW.growthSpan * (this.#rate - last)) / last) ** 2;
    const g = FLOW.growthNear + (FLOW.growthFar - FLOW.growthNear) * Math.min(1, distance);
    this.#rate += Math.max((this.#rate * g * step) / rtt, (FLOW.minStepBytesPerSecond * step) / rtt);
    if (last === null) this.#rate = Math.min(this.#rate, Math.max(this.#startRate(), FLOW.startDeliveryGain * (this.#peakDelivery.value(at) ?? 0)));
  }

  /** Where a gentle start begins: lower during a call, which comes first. */
  #startRate(): number {
    return this.#inputs.callActive ? FLOW.callStartBytesPerSecond : FLOW.startBytesPerSecond;
  }

  /** Rule 5: during a call, files stay below the bottleneck minus the call's share. */
  #capForCall(at: number): void {
    const room = this.#room(at);
    if (room !== null && this.#state === 'controlled') this.#rate = Math.min(this.#rate, room);
  }

  /** Files have been going out for a full delivery reading: what arrives is a real measurement. */
  #deliveryKnown(at: number): boolean {
    return this.#sendingSince !== null && at - this.#sendingSince >= FLOW.deliveryWindowMs;
  }

  /** What files may use during a call with a known bottleneck (never below the floor), or null. */
  #room(at: number): number | null {
    const room = this.#guard.room(this.#inputs, this.#target.noise(at), at);
    return room === null ? null : floored(room);
  }

  #decide(at: number, reading: DelayReading, target: number, noise: number): void {
    const capacity = this.#guard.capacity(this.#inputs, noise, at);
    this.#decision = {
      at,
      state: this.#state,
      limit: this.limit,
      qdMs: reading.qd,
      qdAvgMs: reading.qdAvg,
      rttMs: reading.sRtt,
      deliveryBytesPerSecond: this.#delivery,
      targetMs: target,
      noiseMs: noise,
      reserveBytesPerSecond: capacity === null ? null : this.#guard.share(this.#inputs, capacity),
    };
    this.events.emit('decision', this.#decision);
  }
}
