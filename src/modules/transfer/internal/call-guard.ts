import { FLOW } from '../../../shared/config';
import { Windowed } from '../../../shared/windowed';
import { CallReserve } from './call-reserve';

/** Plain inputs from the composition root; the controller never reads stats itself (I in SOLID). */
export interface CallInputs {
  callActive: boolean;
  /** Our own camera is sending. */
  videoOn: boolean;
  /** Audio + video send rate, bits/s. */
  mediaSendBps: number;
  /** The video cap actually applied to our sender, bits/s (Files first), or null: the call reserve's video ceiling follows it. */
  videoCapBps: number | null;
}

/** One sample, as the guard needs it. */
interface GuardSample {
  qd: number;
  /** Bytes that arrived since the previous echo, over how long; null when there is no previous one. */
  since: { bytes: number; ms: number } | null;
  /** Files have been going out for a full delivery reading. */
  deliveryKnown: boolean;
  target: number;
  noise: number;
  mediaSendBps: number;
}

/** The capacity-based reserve applies only on a path quiet enough to measure the bottleneck. */
const reserveOn = (noise: number): boolean => noise < FLOW.reserveNoiseMs;

/**
 * Rule 5's knowledge (PLAN.md §5.4): the bottleneck as a busy link measured it, whether it can be
 * trusted on this path, and the room it leaves files during a call. On a noisy (radio) path the
 * call is protected by the queueing-delay target alone.
 */
export class CallGuard {
  readonly #reserve = new CallReserve();
  /** The smallest queueing delay lately: a queue that stood in every probe, which radio jitter does not. */
  readonly #standing = new Windowed('min', FLOW.standingQueueMs, FLOW.standingQueueBuckets);
  /** The reserve was in force at the last sample: switching off forgets its capacity. */
  #wasOn = true;

  observe({ qd, since, deliveryKnown, target, noise, mediaSendBps }: GuardSample, at: number): void {
    // Every probe for `standingQueueMs` found a queue while files were going out: the bottleneck
    // stayed busy, so what arrived meanwhile is what it carries, its capacity. Two probes in a row
    // weren't enough: radio jitter passed for a queue (see `FLOW.standingQueueMs`). With no files
    // going out, what arrived says nothing about it: on localhost, a page busy starting a call
    // delayed idle probes by 35 ms, and that "busy" link capped the next transfer at 0.45 MiB/s for 30 s. Half the target, where marking starts, is
    // clear of the media's own frames, which leave in bursts and queue for a few ms: sampled at a
    // quarter of it, what the link happened to carry became the cap, and on the bench that
    // ratcheted files down to the 70 % reserve limit.
    this.#standing.add(qd, at);
    // Clear of the path's own noise too: radio jitter that stands for a couple of slots passed for a
    // busy bottleneck, and the call's share, cut from Flow's own demand, ratcheted files down.
    const busyFrom = Math.max(target / 2, FLOW.noiseBusyFactor * noise);
    // Nor before a full delivery reading: 0.28 s into a transfer, with nothing arrived yet, the call's
    // trickle of media passed for the capacity and the reserve floored files (field, 2026-11-02).
    const busy = deliveryKnown && (this.#standing.value(at) ?? 0) >= busyFrom;
    // On a noisy path the reserve is off, measures nothing, and forgets what it measured, so a stall
    // seen while it was off can't come back as the cap when the noise falls (PLAN-RESERVE AC2b).
    const on = reserveOn(noise);
    if (!on && this.#wasOn) this.#reserve.reset();
    this.#wasOn = on;
    if (on && busy && since) this.#reserve.busy(since.bytes, since.ms, mediaSendBps, at);
  }

  /** The bottleneck as last measured, call or not, or null. */
  measured(at: number): number | null {
    return this.#reserve.capacity(at);
  }

  /** The bottleneck as the call reserve knows it: during a call, on a quiet path, once measured; else null. */
  capacity(inputs: CallInputs, noise: number, at: number): number | null {
    return inputs.callActive && reserveOn(noise) ? this.#reserve.capacity(at) : null;
  }

  /** What the call keeps of a bottleneck of `capacity`. */
  share(inputs: CallInputs, capacity: number): number {
    return this.#reserve.reserve(inputs.mediaSendBps, inputs.videoOn, capacity, inputs.videoCapBps);
  }

  /** What files may use during a call with a known bottleneck (before the floor), or null. */
  room(inputs: CallInputs, noise: number, at: number): number | null {
    const capacity = this.capacity(inputs, noise, at);
    return capacity === null ? null : capacity - this.share(inputs, capacity);
  }

  reset(): void {
    this.#reserve.reset();
    this.#standing.reset();
  }
}
