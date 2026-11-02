import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { QueueTarget } from './queue-target';

const STEP = 40;

/** Rule 7 samples for `ms` from `from`: a queue of `qdAvg`, files `starved` or not, no call. */
function external(target: QueueTarget, from: number, ms: number, qdAvg: number, starved: boolean): number {
  for (let at = from; at < from + ms; at += STEP) target.external(qdAvg, target.value(false, 0), starved, false, STEP, at);
  return from + ms;
}

describe('QueueTarget', () => {
  it('is the call’s target during a call and the idle one otherwise', () => {
    const target = new QueueTarget();
    expect(target.value(true, 0)).toBe(FLOW.targetCallMs);
    expect(target.value(false, 0)).toBe(FLOW.targetIdleMs);
  });

  it('never lets marking start inside the path’s own noise: at least twice the noise, up to its cap', () => {
    const target = new QueueTarget();
    expect(target.value(true, 25)).toBe(FLOW.noiseTargetFactor * 25);
    expect(target.value(true, 80)).toBe(FLOW.noiseTargetMaxMs);
    for (let i = 0; i < 20; i++) target.clean(20, i * STEP);
    expect(target.noise(20 * STEP)).toBeCloseTo(20, 6);
  });

  it('grows the idle target when a queue that isn’t ours persists, and shrinks back once it clears (rule 7)', () => {
    const target = new QueueTarget();
    let at = external(target, 0, FLOW.externalQueueMs + STEP, 100, true);
    expect(target.value(false, 0)).toBeCloseTo(FLOW.targetIdleMs * FLOW.externalStep, 6);
    at = external(target, at, 30_000, 100, true);
    expect(target.value(false, 0)).toBeCloseTo(FLOW.targetIdleMs * FLOW.externalStep ** 2, 6); // Above that queue now: it stops growing.
    at = external(target, at, 60_000, 1_000, true);
    expect(target.value(false, 0)).toBe(FLOW.targetMaxMs);
    external(target, at, 60_000, 5, false);
    expect(target.value(false, 0)).toBeLessThan(FLOW.targetMaxMs / 2);
  });

  it('a queue while files are not starved is ours: the target stays', () => {
    const target = new QueueTarget();
    external(target, 0, 10_000, 100, false);
    expect(target.value(false, 0)).toBe(FLOW.targetIdleMs);
  });

  it('a call, a call start or a reset puts it back at once', () => {
    for (const restore of [(t: QueueTarget) => t.callStarted(), (t: QueueTarget) => t.reset(), (t: QueueTarget) => t.external(100, 60, true, true, STEP, 0)]) {
      const target = new QueueTarget();
      external(target, 0, 10_000, 100, true);
      restore(target);
      expect(target.value(false, 0)).toBe(FLOW.targetIdleMs);
    }
  });
});
