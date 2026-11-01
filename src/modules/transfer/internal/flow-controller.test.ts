import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import type { DelayReading } from './delay-estimator';
import { FlowController, type FlowDecision, type FlowInputs } from './flow-controller';

const KIB = 1024;
const MIB = 1024 * KIB;
const STEP = FLOW.probeIntervalMs;
const RTT = 50;
/** A path this short starts unlimited (rule 1); the tests that follow a mark start on one. */
const NEAR_RTT = 5;
/** A queue that marks fully without a call (above the 60 ms target), short of a deep queue (4 × target). */
const MARKED = 100;
const DEEP = 4 * FLOW.targetIdleMs + 1;
const VIDEO_CALL: FlowInputs = { callActive: true, videoOn: true, mediaSendBps: 0 };

const reading = (qdAvg: number, sRtt = RTT): DelayReading => ({ qd: qdAvg, qdAvg, sRtt, baseRtt: sRtt, validated: false });

/** A controller fed one echo every 40 ms. The pacer is using the budget unless `appLimited`. */
class Harness {
  now = 0;
  appLimited = false;
  readonly flow: FlowController;

  constructor({ drains = true } = {}) {
    this.flow = new FlowController({ now: () => this.now, pacerWaitAt: () => (this.appLimited ? -Infinity : this.now), drains });
  }

  /** Files start going out, on a near path unless `baseRttMs` says otherwise. */
  start(baseRttMs: number | null = NEAR_RTT): this {
    this.flow.sending(true, this.now, baseRttMs);
    return this;
  }

  /** Echoes for `ms`: each sees `qdAvg` ms of queue and `delivery` bytes/s arriving. */
  run(ms: number, qdAvg: number, delivery: number, sRtt = RTT): this {
    for (const end = this.now + ms; this.now < end; ) {
      this.now += STEP;
      const since = { bytes: (delivery * STEP) / 1000, ms: STEP };
      this.flow.update(reading(qdAvg, sRtt), { bytesPerSecond: delivery, recentBytesPerSecond: delivery, since }, this.now);
    }
    return this;
  }

  /** Files start, and the first sample after a full delivery window sees a queue: controlled at 0.9 × `delivery`. */
  enter(delivery: number): this {
    return this.start().run(Math.ceil(FLOW.deliveryWindowMs / STEP) * STEP, MARKED, delivery);
  }

  call(inputs: Partial<FlowInputs>): this {
    this.flow.setInputs(inputs, this.now);
    return this;
  }
}

describe('FlowController: rate (PLAN.md §5.3)', () => {
  it('stays unlimited with no queue, and with one under half the target', () => {
    const h = new Harness().start().run(10_000, 0, 4 * MIB).run(10_000, FLOW.targetIdleMs / 2, 4 * MIB);
    expect(h.flow).toMatchObject({ state: 'unlimited', limit: null });
  });

  it('takes control only after a full delivery window of sending, just under what arrives', () => {
    const h = new Harness().start().run(FLOW.deliveryWindowMs - 20, MARKED, 4 * MIB);
    expect(h.flow.limit).toBeNull();
    h.run(STEP, MARKED, 4 * MIB);
    expect(h.flow).toMatchObject({ state: 'controlled', limit: FLOW.entryFactor * 4 * MIB });
  });

  it('starts gently on a far path while the bottleneck is unknown (1 MiB/s without a call), and grows quickly from there', () => {
    const h = new Harness().start(RTT);
    expect(h.flow).toMatchObject({ state: 'controlled', limit: FLOW.startBytesPerSecond });
    h.run(STEP, 0, FLOW.startBytesPerSecond);
    expect(h.flow.limit).toBeCloseTo(FLOW.startBytesPerSecond * (1 + (FLOW.growthFar * STEP) / RTT), 6);
    expect(new Harness().start(null).flow.limit).toBeNull(); // Round trip unknown: as near.
  });

  it('until the first congestion point, never grows past what arrives times the start gain', () => {
    const D = 4 * MIB;
    const h = new Harness().start(RTT).run(2_000, 0, D);
    expect(h.flow.limit).toBeCloseTo(FLOW.startDeliveryGain * D, 6);
    h.run(STEP, MARKED, D).run(STEP, 0, D); // A congestion point: growth is the usual again.
    expect(h.flow.limit).toBeGreaterThan(0);
  });

  it('…by the most that arrived in the last second: a moment with nothing arriving does not pull it back', () => {
    // On the bench, lanes stalled behind a lost packet or waking from idle made what arrives come
    // in bursts; bounded by the latest reading, a far path stayed at the start rate throughout.
    const D = 4 * MIB;
    const h = new Harness().start(RTT);
    for (let k = 0; k < 25; k++) h.run(STEP, 0, D).run(3 * STEP, 0, 0);
    expect(h.flow.limit).toBeCloseTo(FLOW.startDeliveryGain * D, 6);
    h.run(FLOW.startDeliveryWindowMs, 0, D / 4); // The bursts have left the window.
    expect(h.flow.limit).toBeCloseTo((FLOW.startDeliveryGain * D) / 4, 6);
  });

  it('out of a gentle start, the congestion point is the recent peak of what arrived, not the half-second reading that lags the ramp', () => {
    const D = 4 * MIB;
    const h = new Harness().start(RTT);
    const ramp = (qdAvg: number) => {
      h.now += STEP;
      h.flow.update(reading(qdAvg), { bytesPerSecond: D / 2, recentBytesPerSecond: D, since: null }, h.now);
    };
    for (let k = 0; k < 20; k++) ramp(0);
    ramp(MARKED); // The first mark: cut to just under what the lagging reading shows...
    h.run(10 * STEP, 0, D); // ...and back near D quickly, since that is where the link was full.
    expect(h.flow.limit).toBeGreaterThan(0.75 * D);
  });

  it('cuts in proportion to the marking, at most α/2 per round trip', () => {
    const D = 4 * MIB;
    const cut = (qdAvg: number) => new Harness().enter(D).run(STEP, qdAvg, D, 100).flow.limit! / (FLOW.entryFactor * D);
    const share = STEP / 100;
    expect(cut(FLOW.targetIdleMs)).toBeCloseTo(1 - (1 / 2) * share, 9); // α = 1
    expect(cut(48)).toBeCloseTo(1 - (0.6 / 2) * share, 9); // α = 0.6
  });

  it.each([
    [0.5, 45],
    [1, MARKED],
  ])('under steady marking α = %d settles at (1 − α/2) × delivery, not lower', (alpha, qdAvg) => {
    const D = 4 * MIB;
    expect(new Harness().enter(D).run(2_000, qdAvg, D).flow.limit).toBeCloseTo((1 - alpha / 2) * D, 0);
  });

  it('never goes below the floor', () => {
    const h = new Harness().enter(16 * KIB).run(2_000, MARKED, 16 * KIB);
    expect(h.flow.limit).toBe(FLOW.minBytesPerSecond);
    h.run(2_000, 1_000, 0); // A deep queue with nothing arriving.
    expect(h.flow.limit).toBe(FLOW.minBytesPerSecond);
  });

  it('drains a deep queue at once: above 4 × the target it cuts to a quarter of what arrives', () => {
    const D = 4 * MIB;
    expect(new Harness().enter(D).run(STEP, DEEP, D).flow.limit).toBe(FLOW.deepFactor * D);
  });

  it('regrows quickly far below the last congestion point, carefully near and above it', () => {
    const D = 8 * MIB;
    const h = new Harness().enter(D).run(STEP, DEEP, D); // A quarter of the last congestion point.
    const growth = () => {
      const before = h.flow.limit!;
      return h.run(STEP, 0, D).flow.limit! / before - 1;
    };
    expect(growth()).toBeCloseTo((FLOW.growthFar * STEP) / RTT, 9);
    while (h.flow.limit! < D) h.run(STEP, 0, D);
    expect(growth()).toBeCloseTo((FLOW.growthNear * STEP) / RTT, 9);
  });

  it('does not grow while the app, not the budget, sets the pace', () => {
    const D = 4 * MIB;
    const h = new Harness().enter(D);
    const before = h.flow.limit!;
    h.appLimited = true;
    expect(h.run(5_000, 0, D).flow.limit).toBe(before);
    h.appLimited = false;
    expect(h.run(STEP, 0, D).flow.limit).toBeGreaterThan(before);
  });

  it('halves on a feedback gap while controlled, never below the floor', () => {
    const h = new Harness().start();
    h.flow.feedbackGap();
    expect(h.flow.limit).toBeNull();
    h.enter(4 * MIB);
    h.flow.feedbackGap();
    expect(h.flow.limit).toBe(FLOW.entryFactor * 2 * MIB);
    for (let i = 0; i < 20; i++) h.flow.feedbackGap();
    expect(h.flow.limit).toBe(FLOW.minBytesPerSecond);
  });

  it('goes back to unlimited once the budget is above anything a link carries', () => {
    const D = 80 * MIB;
    const h = new Harness().enter(D);
    expect(h.flow.state).toBe('controlled');
    expect(h.run(STEP, 0, D).flow).toMatchObject({ state: 'unlimited', limit: null });
  });

  it('reports every decision with what it saw', () => {
    const decisions: FlowDecision[] = [];
    const h = new Harness();
    h.flow.events.on('decision', (d) => decisions.push(d));
    h.start().run(2 * STEP, 10, 2 * MIB);
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toEqual({
      at: 2 * STEP,
      state: 'unlimited',
      limit: null,
      qdMs: 10,
      qdAvgMs: 10,
      rttMs: RTT,
      deliveryBytesPerSecond: 2 * MIB,
      targetMs: FLOW.targetIdleMs,
      reserveBytesPerSecond: null,
    });
    expect(h.flow.decision).toBe(decisions[1]);
  });
});

describe('FlowController: validation drains (rule 6, FLOW-10)', () => {
  it('wants one after 20 s of sending with no clean base sample, in unlimited too', () => {
    const h = new Harness().start().run(FLOW.baseValidateMs - STEP, 0, 4 * MIB);
    expect(h.flow.wantsDrain(h.now, -Infinity)).toBe(false);
    h.run(STEP, 0, 4 * MIB);
    expect(h.flow.state).toBe('unlimited');
    expect(h.flow.wantsDrain(h.now, -Infinity)).toBe(true);
    expect(h.flow.wantsDrain(h.now, h.now - 1_000)).toBe(false); // A clean sample a second ago.
  });

  it('wants one right after a reset while sending, until a clean sample comes, and none while idle', () => {
    const h = new Harness();
    h.flow.reset(h.now);
    expect(h.flow.wantsDrain(h.now, -Infinity)).toBe(false);
    h.start().run(1_000, 0, 4 * MIB);
    expect(h.flow.wantsDrain(h.now, h.now)).toBe(false);
    const resetAt = h.now;
    h.flow.reset(resetAt); // The estimator starts over too: no clean sample since.
    expect(h.flow.wantsDrain(h.now, -Infinity)).toBe(true);
    h.run(STEP, 0, 4 * MIB);
    expect(h.flow.wantsDrain(h.now, resetAt + 1)).toBe(false); // An idle probe's echo since then settles it.
  });

  it('after a reset, a failed drain is tried again 5 s later, not 20 s into the transfer', () => {
    const D = 4 * MIB;
    const h = new Harness().start().run(1_000, 0, D);
    h.flow.reset(h.now);
    h.flow.startDrain(h.now);
    h.run(FLOW.drainMaxMs, 0, D);
    h.flow.endDrain(false, h.now);
    expect(h.flow.wantsDrain(h.now + FLOW.drainRetryMs - 1, -Infinity)).toBe(false);
    expect(h.flow.wantsDrain(h.now + FLOW.drainRetryMs, -Infinity)).toBe(true);
    h.flow.startDrain(h.now + FLOW.drainRetryMs);
    h.flow.endDrain(true, h.now + FLOW.drainRetryMs + 500);
    expect(h.flow.wantsDrain(h.now + FLOW.drainRetryMs + 500 + STEP, -Infinity)).toBe(false); // Validated: settled.
  });

  it('never drains in shadow mode', () => {
    const h = new Harness({ drains: false }).start().run(30_000, 0, 4 * MIB);
    h.flow.reset(h.now);
    expect(h.flow.wantsDrain(h.now, -Infinity)).toBe(false);
  });

  it('holds new writes until its deadline; validated, it goes back to where it was', () => {
    const D = 4 * MIB;
    const h = new Harness().enter(D);
    const rate = h.flow.limit;
    h.flow.startDrain(h.now);
    expect(h.flow).toMatchObject({ state: 'draining', limit: 0, hold: { until: h.now + FLOW.drainMaxMs, release: rate } });
    expect(h.run(1_000, MARKED, D).flow.limit).toBe(0); // Samples change nothing meanwhile.
    h.flow.endDrain(true, h.now);
    expect(h.flow).toMatchObject({ state: 'controlled', limit: rate, hold: null });
  });

  it('lets a hold go at its deadline by itself, even while nothing has ended the drain yet (FLOW-13)', () => {
    const D = 4 * MIB;
    const h = new Harness().enter(D);
    const rate = h.flow.limit;
    h.flow.startDrain(h.now);
    h.now += FLOW.drainMaxMs - 1;
    expect(h.flow.limit).toBe(0);
    h.now += 1;
    expect(h.flow).toMatchObject({ state: 'draining', limit: rate });
  });

  it('failed from unlimited: stops sending unlimited (0.9 × delivery), and tries again 5 s later', () => {
    const D = 4 * MIB;
    const h = new Harness().start().run(FLOW.baseValidateMs, 0, D);
    h.flow.startDrain(h.now);
    expect(h.flow.hold?.release).toBe(FLOW.entryFactor * D);
    h.run(FLOW.drainMaxMs, 0, D);
    h.flow.endDrain(false, h.now);
    expect(h.flow).toMatchObject({ state: 'controlled', limit: FLOW.entryFactor * D });
    expect(h.flow.wantsDrain(h.now + FLOW.drainRetryMs - 1, -Infinity)).toBe(false);
    expect(h.flow.wantsDrain(h.now + FLOW.drainRetryMs, -Infinity)).toBe(true);
  });

  it('failed from controlled: keeps its rate', () => {
    const h = new Harness().enter(4 * MIB);
    const rate = h.flow.limit;
    h.flow.startDrain(h.now);
    h.flow.endDrain(false, h.now + FLOW.drainMaxMs);
    expect(h.flow).toMatchObject({ state: 'controlled', limit: rate });
  });
});

describe('FlowController: someone else’s queue (rule 7)', () => {
  const D = 4 * MIB;
  /** Another app fills the queue: files now deliver 40 % of what they did, and are cut to 20 %. */
  const crowded = (h: Harness, ms: number) => h.run(ms, MARKED, 0.4 * D);

  it('raises the target while files are starved by a queue that isn’t theirs, and lowers it once the queue goes', () => {
    const h = new Harness().enter(D);
    crowded(h, FLOW.externalQueueMs + 500);
    expect(h.flow.decision?.targetMs).toBe(FLOW.targetIdleMs * FLOW.externalStep);
    h.run(30_000, 0, D);
    expect(h.flow.decision?.targetMs).toBe(FLOW.targetIdleMs);
  });

  it('never moves the call’s target', () => {
    const h = new Harness().call(VIDEO_CALL).enter(D);
    crowded(h, 10_000);
    expect(h.flow.decision?.targetMs).toBe(FLOW.targetCallMs);
  });
});

describe('FlowController: call first (rule 5, FLOW-06)', () => {
  const D = 1 * MIB;
  /** A video call with its camera on keeps headroom over its 720p ceiling while it sends less. */
  const share = (FLOW.mediaHeadroom * FLOW.videoReserveBps) / 8;
  const room = D - share;

  it('a call starting mid-transfer gets its share at the event, and files stay below the rest', () => {
    const h = new Harness().enter(D); // The queue showed the bottleneck: C = D.
    h.call(VIDEO_CALL);
    expect(h.flow.limit).toBeCloseTo(room, 6);
    h.run(STEP, 0, D);
    expect(h.flow.decision).toMatchObject({ targetMs: FLOW.targetCallMs, reserveBytesPerSecond: share });
    expect(h.run(5_000, 0, D).flow.limit).toBeLessThanOrEqual(room);
  });

  it('a call starting while files go unlimited takes control at the bottleneck minus the call', () => {
    const h = new Harness().start().run(FLOW.deliveryWindowMs - 100, MARKED, D); // Too soon to take control, but C is known.
    expect(h.flow.limit).toBeNull();
    h.call(VIDEO_CALL);
    expect(h.flow.state).toBe('controlled');
    expect(h.flow.limit).toBeCloseTo(room, 6);
  });

  it('measures the bottleneck over the time it stays busy, so what arrives in bursts does not overstate it', () => {
    // On the bench, the largest of short readings put the bottleneck a third too high, and files took the call's share.
    const h = new Harness().start();
    for (let k = 0; k < 10; k++) h.run(STEP, MARKED, (k % 2 ? 1.4 : 0.6) * D);
    expect(h.call(VIDEO_CALL).flow.limit).toBeCloseTo(room, 6);
  });

  it('measures it only while the queue shows it busy, from half the target: below that, what arrives says nothing about it', () => {
    const below = new Harness().start().run(FLOW.deliveryWindowMs - 100, FLOW.targetIdleMs / 2 - 1, D);
    expect(below.call(VIDEO_CALL).flow.limit).toBeNull();
    const busy = new Harness().start().run(FLOW.deliveryWindowMs - 100, FLOW.targetIdleMs / 2, D);
    expect(busy.call(VIDEO_CALL).flow.limit).toBeCloseTo(room, 6);
  });

  it('learns nothing about the bottleneck while no files go out', () => {
    // On localhost, a page busy starting a call delayed idle probes; read as a busy link that carried no files, it capped the next transfer for 30 s.
    const h = new Harness().call(VIDEO_CALL).run(5_000, MARKED, D);
    expect(h.flow.decision?.reserveBytesPerSecond).toBeNull();
    expect(h.start(RTT).flow.limit).toBe(FLOW.callStartBytesPerSecond); // Still unknown: the gentle start, not a cap.
  });

  it('the first transfer in a call starts at 256 KiB/s on a far path while the bottleneck is unknown, unlimited on a near one', () => {
    expect(new Harness().call(VIDEO_CALL).start(RTT).flow.limit).toBe(FLOW.callStartBytesPerSecond);
    expect(new Harness().call(VIDEO_CALL).start(NEAR_RTT).flow.limit).toBeNull();
  });

  it('files that started before any round trip was known take their start from the first one, and only from that one', () => {
    const far = new Harness().call(VIDEO_CALL).start(null);
    expect(far.flow.limit).toBeNull();
    far.flow.pathRtt(RTT, far.now);
    expect(far.flow.limit).toBe(FLOW.callStartBytesPerSecond);

    const near = new Harness().call(VIDEO_CALL).start(null);
    near.flow.pathRtt(NEAR_RTT, near.now);
    near.flow.pathRtt(RTT, near.now); // Decided: a later reading changes nothing.
    expect(near.flow.limit).toBeNull();

    const known = new Harness().call(VIDEO_CALL).start(NEAR_RTT);
    known.flow.pathRtt(RTT, known.now);
    expect(known.flow.limit).toBeNull();

    const ended = new Harness().start(null);
    ended.flow.sending(false, ended.now, null);
    ended.flow.pathRtt(RTT, ended.now); // Not sending: nothing to start.
    expect(ended.flow.limit).toBeNull();
  });
});
