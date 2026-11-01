import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { DelayEstimator, type DelayReading } from './delay-estimator';
import type { FlowSample } from './flow-probe';

interface Echo {
  /** When the echo arrived, on the sender's clock. */
  at: number;
  forwardMs: number;
  reverseMs: number;
  /** The receiver's clock minus the sender's. */
  offsetMs?: number;
  idle?: boolean;
}

/** The sample one probe gives across a path with these one-way delays. */
function echo({ at, forwardMs, reverseMs, offsetMs = 0, idle = false }: Echo): FlowSample {
  const sentAt = at - forwardMs - reverseMs;
  return { at, sentAt, rttMs: forwardMs + reverseMs, owdMs: forwardMs + offsetMs, rxBytes: 0, rxAt: sentAt + forwardMs + offsetMs, idle };
}

describe('DelayEstimator: forward queueing delay', () => {
  it('measures the forward queue whatever the offset between the two clocks', () => {
    const queue = [0, 0, 0, 20, 40, 60, 60, 30, 0, 0];
    const readings = (offsetMs: number) => {
      const estimator = new DelayEstimator();
      return queue.map((q, i) => estimator.add(echo({ at: 1_000 + i * 40, forwardMs: 15 + q, reverseMs: 15, offsetMs })).qd);
    };
    const base = readings(0);
    expect(base).toEqual([0, 0, 0, 0, 20, 40, 60, 30, 0, 0]); // The jitter filter waits one sample for a rise.
    for (const offset of [-3_600_000, 1_234.5678, 86_400_000]) readings(offset).forEach((qd, i) => expect(qd).toBeCloseTo(base[i]!, 6));
  });

  it('keeps clock drift of 200 ppm under 15 ms of error, whichever clock runs fast', () => {
    for (const ppm of [200, -200]) {
      const estimator = new DelayEstimator();
      let worst = 0;
      for (let at = 0; at <= 300_000; at += 40) {
        const drift = (ppm / 1e6) * at;
        worst = Math.max(worst, estimator.add(echo({ at, forwardMs: 20, reverseMs: 20, offsetMs: 5_000 + drift })).qdAvg);
      }
      expect(worst).toBeLessThan(15);
    }
  });

  it('a reverse-path queue that comes and goes neither hides nor fakes a forward queue (FLOW-04)', () => {
    const estimator = new DelayEstimator();
    const read = (at: number, forwardQueue: number, reverseQueue: number) =>
      estimator.add(echo({ at, forwardMs: 10 + forwardQueue, reverseMs: 10 + reverseQueue }));
    let at = 0;
    let last: DelayReading | null = null;
    // The shortest one-way delay comes from here, while the reply path queues...
    for (; at < 2_000; at += 40) read(at, 0, 100);
    // ...and the shortest round trip from here, with a 50 ms forward queue in it. A round-trip cap would hide it.
    for (; at < 4_000; at += 40) last = read(at, 50, 0);
    expect(last).toMatchObject({ qd: 50, baseRtt: 70 });
    // A reply queue alone is no forward queue.
    for (; at < 8_000; at += 40) expect(read(at, 0, Math.floor(at / 200) % 2 ? 150 : 0).qd).toBe(0);
  });

  it('ignores a single late sample (one slow event-loop turn), but not a queue', () => {
    const estimator = new DelayEstimator();
    const read = (at: number, forwardMs: number) => estimator.add(echo({ at, forwardMs, reverseMs: 10 }));
    for (let at = 0; at < 1_000; at += 40) read(at, 10);
    expect(read(1_000, 110)).toMatchObject({ qd: 0, qdAvg: 0 });
    expect(read(1_040, 10)).toMatchObject({ qd: 0, qdAvg: 0 });
    read(1_080, 50);
    expect(read(1_120, 50).qd).toBe(40);
  });

  it('averages a rising queue and follows a falling one at once', () => {
    const estimator = new DelayEstimator();
    const read = (at: number, queue: number) => estimator.add(echo({ at, forwardMs: 10 + queue, reverseMs: 10 }));
    for (let at = 0; at < 400; at += 40) read(at, 0);
    read(400, 40); // Filtered out: the first late sample.
    let expected = 0;
    for (let at = 440; at < 600; at += 40) {
      expected += FLOW.qdGainUp * (40 - expected);
      expect(read(at, 40).qdAvg).toBeCloseTo(expected, 9);
    }
    expect(read(600, 0).qdAvg).toBe(0);
  });

  it('starts over on reset: a new base, no round trip, no clean sample', () => {
    const estimator = new DelayEstimator();
    estimator.add(echo({ at: 0, forwardMs: 10, reverseMs: 10, idle: true }));
    expect(estimator.lastCleanAt).toBe(0);
    estimator.reset();
    expect(estimator).toMatchObject({ lastCleanAt: -Infinity, sRtt: null });
    expect(estimator.baseRtt(0)).toBeNull();
    expect(estimator.add(echo({ at: 100, forwardMs: 60, reverseMs: 10 }))).toMatchObject({ qd: 0, qdAvg: 0, sRtt: 70, baseRtt: 70 });
  });
});

describe('DelayEstimator: clean samples (FLOW-10)', () => {
  it('counts a probe that crossed an idle path as clean', () => {
    const estimator = new DelayEstimator();
    estimator.add(echo({ at: 500, forwardMs: 10, reverseMs: 10 }));
    expect(estimator.lastCleanAt).toBe(-Infinity);
    estimator.add(echo({ at: 1_500, forwardMs: 10, reverseMs: 10, idle: true }));
    expect(estimator.lastCleanAt).toBe(1_500);
  });

  it('validates the base only with enough probes sent after the lanes were proved empty, once', () => {
    const estimator = new DelayEstimator();
    const at = 10_000;
    const read = (t: number) => estimator.add(echo({ at: t, forwardMs: 30, reverseMs: 30 }));
    for (let t = 0; t < at; t += 40) read(t);
    estimator.cleanFrom(at);
    expect(read(at + 30).validated).toBe(false); // Its probe left before the lanes were empty.
    expect(read(at + 60).validated).toBe(false); // The first clean one.
    expect(read(at + 100).validated).toBe(true);
    expect(estimator.lastCleanAt).toBe(at + 100);
    expect(read(at + 140).validated).toBe(false);
  });

  it('waits at least a smoothed round trip after the lanes were proved empty', () => {
    const estimator = new DelayEstimator();
    const at = 10_000;
    for (let t = 0; t < at; t += 40) estimator.add(echo({ at: t, forwardMs: 150, reverseMs: 150 }));
    estimator.cleanFrom(at);
    let t = at + 20;
    let reading: DelayReading;
    do {
      t += 40;
      reading = estimator.add(echo({ at: t, forwardMs: 30, reverseMs: 30 }));
    } while (!reading.validated && t < at + 5_000);
    expect(reading.validated).toBe(true);
    expect(t - at).toBeGreaterThan(100); // Two clean samples were in long before.
    expect(t - at).toBeGreaterThanOrEqual(reading.sRtt);
  });

  it('validates nothing once the drain gave up', () => {
    const estimator = new DelayEstimator();
    estimator.add(echo({ at: 0, forwardMs: 10, reverseMs: 10 }));
    estimator.cleanFrom(100);
    estimator.stopCleaning();
    for (let t = 200; t < 2_000; t += 40) expect(estimator.add(echo({ at: t, forwardMs: 10, reverseMs: 10 })).validated).toBe(false);
    expect(estimator.lastCleanAt).toBe(-Infinity);
  });
});
