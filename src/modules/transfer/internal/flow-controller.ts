import { FLOW, LANES } from '../../../shared/config';
import { Emitter } from '../../../shared/emitter';
import { clamp } from '../../../shared/math';
import { Windowed } from '../../../shared/windowed';
import { CallReserve } from './call-reserve';
import type { DelayReading } from './delay-estimator';
import type { RatePolicy } from './rate-policy';

/**
 * - unlimited: no budget, exactly today's behaviour: on a near path until a queue appears, and
 *   on any path once the budget grew past what a link carries.
 * - controlled: the budget is the rate R.
 * - draining: a short hold that proves the base delay was measured on an empty path (rule 6).
 */
export type FlowState = 'unlimited' | 'controlled' | 'draining';

/** Plain inputs from the composition root; the controller never reads stats itself (I in SOLID). */
export interface FlowInputs {
  callActive: boolean;
  /** Our own camera is sending. */
  videoOn: boolean;
  /** Audio + video send rate, bits/s. */
  mediaSendBps: number;
}

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
export interface Hold {
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
  /** What the call keeps, while a call is on and the bottleneck is known. */
  reserveBytesPerSecond: number | null;
}

export interface FlowControllerOptions {
  /** Monotonic: what a hold's deadline is checked against. */
  now(): number;
  /** When the pacer last had to wait: the budget is actually in use. */
  pacerWaitAt(): number;
  /** Validation drains are allowed (Flow in charge); never in shadow mode. */
  drains: boolean;
}

/** A drain in progress: where it came from, and its deadline. */
interface Drain {
  from: 'unlimited' | 'controlled';
  rate: number;
  delivery: number;
  until: number;
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
  readonly #reserve = new CallReserve();
  /** The most that arrived lately (`FLOW.startDeliveryWindowMs`): what bounds a gentle start. */
  readonly #peakDelivery = new Windowed('max', FLOW.startDeliveryWindowMs, FLOW.startDeliveryBuckets);
  #state: FlowState = 'unlimited';
  /** R, bytes/s: the budget while controlled. */
  #rate = 0;
  /** R_last: the rate at the last congestion point; null when unknown. */
  #rateLast: number | null = null;
  #marked = false;
  #targetScale = 1;
  #externalSince: number | null = null;
  #lastAt: number | null = null;
  #delivery = 0;
  #sendingSince: number | null = null;
  #inputs: FlowInputs = { callActive: false, videoOn: false, mediaSendBps: 0 };
  #drain: Drain | null = null;
  #retryAt = -Infinity;
  /** When a reset while sending made the base suspect (null: it isn't): it is validated before it is trusted again. */
  #suspectSince: number | null = null;
  /** Files started before any round trip was known: rule 1 waits for the first. */
  #startPending = false;
  #decision: FlowDecision | null = null;

  constructor(private readonly options: FlowControllerOptions) {}

  get limit(): number | null {
    const drain = this.#drain;
    // A hold never outlives its deadline, whatever is late to end the drain (FLOW-13).
    if (drain) return this.options.now() >= drain.until ? this.#release(drain) : 0;
    return this.#state === 'unlimited' ? null : this.#rate;
  }

  get state(): FlowState {
    return this.#state;
  }

  get hold(): Hold | null {
    return this.#drain && { until: this.#drain.until, release: this.#release(this.#drain) };
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
    this.#targetScale = 1;
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
    const target = this.#target();
    const alpha = clamp((reading.qdAvg - target / 2) / (target / 2), 0, 1);
    // Two probes in a row found a queue while files were going out (the reading is the smaller of
    // the two): the bottleneck stayed busy between them, so what arrived meanwhile is what it
    // carries, its capacity. With no files going out, what arrived says nothing about it: on
    // localhost, a page busy starting a call delayed idle probes by 35 ms, and that "busy" link
    // capped the next transfer at 0.45 MiB/s for 30 s. Half the target, where marking starts, is
    // clear of the media's own frames, which leave in bursts and queue for a few ms: sampled at a
    // quarter of it, what the link happened to carry became the cap, and on the bench that
    // ratcheted files down to the 70 % reserve limit.
    const busy = this.#sendingSince !== null && reading.qd >= target / 2;
    if (busy && delivery.since) this.#reserve.busy(delivery.since.bytes, delivery.since.ms, this.#inputs.mediaSendBps, at);

    if (this.#state !== 'draining' && this.#sendingSince !== null) {
      if (this.#state === 'unlimited') this.#maybeEnter(alpha, at);
      else this.#adjust(alpha, reading.qdAvg, target, step, rtt, at);
      this.#external(reading.qdAvg, target, step, at);
    }
    this.#decide(at, reading, target);
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
    this.#targetScale = 1;
    this.#externalSince = null;
    this.#reserve.reset();
    this.#peakDelivery.reset();
    // While sending, the new base may be measured over a standing queue; idle probes are clean anyway.
    this.#suspectSince = this.#sendingSince !== null ? at : null;
  }

  /** Rule 6: time to prove the base was measured on an empty path. */
  wantsDrain(at: number, lastCleanAt: number): boolean {
    if (!this.options.drains || this.#state === 'draining' || this.#sendingSince === null || at < this.#retryAt) return false;
    // After a reset while sending, until a clean sample comes: a failed drain is tried again as soon as `drainRetryMs` allows.
    const suspect = this.#suspectSince !== null && lastCleanAt < this.#suspectSince;
    return suspect || at - Math.max(lastCleanAt, this.#sendingSince) >= FLOW.baseValidateMs;
  }

  /** Rule 6, step 1: hold new writes, for at most `drainMaxMs` in all. */
  startDrain(at: number): void {
    if (this.#state === 'draining') return;
    this.#drain = { from: this.#state, rate: this.#rate, delivery: this.#delivery, until: at + FLOW.drainMaxMs };
    this.#state = 'draining';
  }

  /**
   * The drain ended: validated, it returns to where it was; otherwise nothing is certified and the
   * hold is released to a positive rate (controlled keeps its rate, unlimited stops sending
   * unlimited), with another attempt after `drainRetryMs`.
   */
  endDrain(validated: boolean, at: number): void {
    const drain = this.#drain;
    if (!drain) return;
    this.#drain = null;
    if (validated) {
      this.#state = drain.from;
      this.#rate = drain.rate;
      this.#suspectSince = null;
      return;
    }
    this.#control(this.#release(drain), drain.from === 'controlled' ? this.#rateLast : drain.delivery);
    this.#retryAt = at + FLOW.drainRetryMs;
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
    if (this.#state === 'unlimited' && far && this.#reserve.capacity(at) === null) this.#control(this.#startRate(), null);
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

  /** What files may use during a call with a known bottleneck, or null. */
  #room(at: number): number | null {
    if (!this.#inputs.callActive) return null;
    const capacity = this.#reserve.capacity(at);
    if (capacity === null) return null;
    return floored(capacity - this.#callShare(capacity));
  }

  /** What the call keeps of a bottleneck of `capacity`. */
  #callShare(capacity: number): number {
    return this.#reserve.reserve(this.#inputs.mediaSendBps, this.#inputs.videoOn, capacity);
  }

  /**
   * Rule 7 (no call only, SCReAM adjust_qdelay_target): a queue above target that persists while
   * files are down to a quarter of their last rate isn't ours, so the target grows, up to 400 ms;
   * it shrinks back once the queue is under half of it.
   */
  #external(qdAvg: number, target: number, step: number, at: number): void {
    if (this.#inputs.callActive) {
      this.#targetScale = 1;
      this.#externalSince = null;
      return;
    }
    const starved = this.#state === 'controlled' && this.#rateLast !== null && this.#rate <= FLOW.externalStarvedShare * this.#rateLast;
    if (qdAvg > target && starved) {
      this.#externalSince ??= at;
      if (at - this.#externalSince < FLOW.externalQueueMs) return;
      this.#targetScale = Math.min(FLOW.targetMaxMs / FLOW.targetIdleMs, this.#targetScale * FLOW.externalStep);
      this.#externalSince = at;
    } else {
      this.#externalSince = null;
      if (qdAvg < target / 2) this.#targetScale = Math.max(1, this.#targetScale * FLOW.externalDecayPerSecond ** (step / 1000));
    }
  }

  /** The queueing-delay target, ms: call first, or the idle target, grown if another app owns the queue. */
  #target(): number {
    return this.#inputs.callActive ? FLOW.targetCallMs : FLOW.targetIdleMs * this.#targetScale;
  }

  #decide(at: number, reading: DelayReading, target: number): void {
    const capacity = this.#inputs.callActive ? this.#reserve.capacity(at) : null;
    this.#decision = {
      at,
      state: this.#state,
      limit: this.limit,
      qdMs: reading.qd,
      qdAvgMs: reading.qdAvg,
      rttMs: reading.sRtt,
      deliveryBytesPerSecond: this.#delivery,
      targetMs: target,
      reserveBytesPerSecond: capacity === null ? null : this.#callShare(capacity),
    };
    this.events.emit('decision', this.#decision);
  }
}
