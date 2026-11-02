import { describe, expect, it } from 'vitest';
import { FLOW, TRANSFER } from '../../../shared/config';
import { Emitter } from '../../../shared/emitter';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { FlowController } from './flow-controller';
import type { Capability, FlowSample } from './flow-probe';
import { PacingSelector } from './pacing-selector';
import { AdaptiveRateLimit, type RatePolicy } from './rate-policy';

const MB = 1024 * 1024;
const calm = { callActive: true, rttMs: 20, lossPercent: 0 };

describe('AdaptiveRateLimit (call-aware pacing)', () => {
  it('never limits files when there is no call', () => {
    const rate = new AdaptiveRateLimit();
    rate.update({ callActive: false, rttMs: 900, lossPercent: 50 }, 10 * MB);
    expect(rate.limit).toBeNull();
  });

  it('stays unlimited during a healthy call', () => {
    const rate = new AdaptiveRateLimit();
    for (let i = 0; i < 10; i++) rate.update(calm, 10 * MB);
    expect(rate.limit).toBeNull();
  });

  it('backs off multiplicatively on loss, never below the floor', () => {
    const rate = new AdaptiveRateLimit();
    rate.update({ ...calm, lossPercent: 12 }, 10 * MB);
    expect(rate.limit).toBeCloseTo(7 * MB);
    for (let i = 0; i < 50; i++) rate.update({ ...calm, lossPercent: 12 }, 0);
    expect(rate.limit).toBe(TRANSFER.minFileBytesPerSecond);
  });

  it('treats a growing round trip as congestion, then ramps back to unlimited quickly', () => {
    const rate = new AdaptiveRateLimit();
    rate.update(calm, 4 * MB); // Learns the base RTT.
    rate.update({ ...calm, rttMs: 200 }, 4 * MB);
    expect(rate.limit).toBeCloseTo(2.8 * MB);
    let ticks = 0;
    while (rate.limit !== null && ticks < 100) {
      rate.update(calm, 4 * MB);
      ticks++;
    }
    expect(rate.limit).toBeNull();
    expect(ticks).toBeLessThan(15);
  });
});

/** What every file budget must do (Liskov), whatever drives it: one observation at a time. */
interface PolicyUnderTest {
  policy: RatePolicy;
  /** The least it ever asks for in response to congestion, bytes/s. */
  floor: number;
  calm(): void;
  congested(): void;
  /** Starts a hold (a budget of 0), or null for a policy that never holds. */
  hold: (() => void) | null;
  /** Lets `ms` pass. */
  advance(ms: number): void;
}

function ratePolicyContract(name: string, make: () => PolicyUnderTest) {
  describe(`RatePolicy contract: ${name}`, () => {
    it('starts with no limit and keeps none while nothing is congested', () => {
      const p = make();
      expect(p.policy.limit).toBeNull();
      for (let i = 0; i < 100; i++) p.calm();
      expect(p.policy.limit).toBeNull();
    });

    it('answers congestion with a finite, positive budget, never below its floor', () => {
      const p = make();
      for (let i = 0; i < 200; i++) {
        p.congested();
        expect(Number.isFinite(p.policy.limit)).toBe(true);
        expect(p.policy.limit).toBeGreaterThanOrEqual(p.floor);
      }
    });

    it('never lowers the budget while calm, and lifts it entirely in the end', () => {
      const p = make();
      for (let i = 0; i < 5; i++) p.congested();
      for (let calm = 0; p.policy.limit !== null && calm < 10_000; calm++) {
        const before = p.policy.limit;
        p.calm();
        if (p.policy.limit !== null) expect(p.policy.limit).toBeGreaterThanOrEqual(before);
      }
      expect(p.policy.limit).toBeNull();
    });

    it('holds (0) only for a moment: a hold ends by itself within `drainMaxMs`', () => {
      const p = make();
      if (!p.hold) {
        for (let i = 0; i < 50; i++) {
          p.congested();
          expect(p.policy.limit).not.toBe(0);
          p.calm();
          expect(p.policy.limit).not.toBe(0);
        }
        return;
      }
      for (let i = 0; i < 5; i++) p.congested();
      p.hold();
      expect(p.policy.limit).toBe(0);
      p.advance(FLOW.drainMaxMs - 1);
      expect(p.policy.limit).toBe(0);
      p.advance(1); // Nothing ended the drain: the hold still lets go at its deadline (FLOW-13).
      expect(p.policy.limit).toBeGreaterThanOrEqual(p.floor);
    });
  });
}

ratePolicyContract('AdaptiveRateLimit (legacy)', () => {
  const policy = new AdaptiveRateLimit();
  return {
    policy,
    floor: TRANSFER.minFileBytesPerSecond,
    calm: () => policy.update(calm, 4 * MB),
    congested: () => policy.update({ ...calm, lossPercent: 12 }, 4 * MB),
    hold: null,
    advance: () => undefined,
  };
});

/** Flow's controller, fed one echo per probe interval, behind `wrap` (the controller itself, or what applies it). */
function flowUnderTest(wrap: (flow: FlowController, clock: FakeClock) => RatePolicy): PolicyUnderTest {
  const clock = new FakeClock();
  const flow = new FlowController({ now: () => clock.now(), pacerWaitAt: () => clock.now(), drains: true });
  flow.sending(true, clock.now() - FLOW.deliveryWindowMs, 5); // A near path: it starts unlimited, like every policy.
  const echo = (qdAvg: number) => {
    clock.advance(FLOW.probeIntervalMs);
    flow.update({ qd: qdAvg, qdRaw: qdAvg, qdAvg, sRtt: 50, baseRtt: 50, validated: false, clean: false }, { bytesPerSecond: 4 * MB, recentBytesPerSecond: 4 * MB, since: null }, clock.now());
  };
  return {
    policy: wrap(flow, clock),
    floor: FLOW.minBytesPerSecond,
    calm: () => echo(0),
    congested: () => echo(100),
    hold: () => flow.startDrain(clock.now()),
    advance: (ms) => clock.advance(ms),
  };
}

ratePolicyContract('FlowController', () => flowUnderTest((flow) => flow));

ratePolicyContract('PacingSelector (flow mode, a peer that answers)', () =>
  flowUnderTest((flow, clock) => {
    const probe = { capability: 'supported' as const, probeNow: () => undefined, events: new Emitter<{ sample: FlowSample; capability: Capability }>() };
    return new PacingSelector({ mode: 'flow', legacy: { limit: TRANSFER.minFileBytesPerSecond }, flow, probe, clock });
  }),
);
