import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { CallGuard, type CallInputs } from './call-guard';

const CALL: CallInputs = { callActive: true, videoOn: true, mediaSendBps: 0, videoCapBps: null };
const STEP = 40;
const LINK = 1_000_000; // Bytes/s arriving while the bottleneck stays busy.

/** `ms` of samples from `from`, every probe finding `qd` of queue; returns when they end. */
function feed(guard: CallGuard, from: number, ms: number, { qd = 20, noise = 0, deliveryKnown = true } = {}): number {
  for (let at = from; at < from + ms; at += STEP) {
    guard.observe({ qd, since: { bytes: (LINK * STEP) / 1000, ms: STEP }, deliveryKnown, target: FLOW.targetCallMs, noise, mediaSendBps: 0 }, at);
  }
  return from + ms;
}

describe('CallGuard (rule 5)', () => {
  it('a queue that stood in every probe means a busy bottleneck: what arrived is its capacity', () => {
    const guard = new CallGuard();
    const at = feed(guard, 0, 600);
    expect(guard.measured(at)).toBeCloseTo(LINK, 6);
    expect(guard.capacity(CALL, 0, at)).toBeCloseTo(LINK, 6);
  });

  it('a queue under half the target, or one that dipped within the window, is not busy', () => {
    const shallow = new CallGuard();
    expect(shallow.measured(feed(shallow, 0, 600, { qd: FLOW.targetCallMs / 2 - 1 }))).toBeNull();
    const jitter = new CallGuard();
    let at = 0;
    for (let i = 0; i < 15; i++) at = feed(jitter, at, STEP, { qd: i % 3 === 0 ? 0 : 40 }); // Radio jitter: gone every third probe.
    expect(jitter.measured(at)).toBeNull();
  });

  it('busy means clear of the path’s noise too, and nothing counts before a full delivery reading', () => {
    const noisy = new CallGuard();
    const noise = 8; // Under the off switch, but 2× noise (16) is above half the target (15).
    expect(noisy.measured(feed(noisy, 0, 600, { qd: 15.5, noise }))).toBeNull();
    const early = new CallGuard();
    expect(early.measured(feed(early, 0, 600, { deliveryKnown: false }))).toBeNull();
  });

  it('on a noisy path it is off: no capacity in a call, and what it had measured is forgotten (AC2b)', () => {
    const guard = new CallGuard();
    let at = feed(guard, 0, 600);
    expect(guard.capacity(CALL, FLOW.reserveNoiseMs, at)).toBeNull();
    at = feed(guard, at, STEP, { noise: FLOW.reserveNoiseMs });
    expect(guard.measured(at)).toBeNull();
  });

  it('caps files only during a call, leaving the call its share; a capped video keeps room for twice its cap', () => {
    const guard = new CallGuard();
    const at = feed(guard, 0, 600);
    expect(guard.capacity({ ...CALL, callActive: false }, 0, at)).toBeNull();
    expect(guard.room(CALL, 0, at)).toBeCloseTo(LINK - (FLOW.mediaHeadroom * FLOW.videoReserveBps) / 8, 6);
    const capped = { ...CALL, videoCapBps: 500_000 };
    expect(guard.share(capped, LINK)).toBeCloseTo((FLOW.mediaHeadroom * FLOW.cappedVideoReserve * 500_000) / 8, 6);
  });
});
