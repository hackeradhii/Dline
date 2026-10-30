import { describe, expect, it } from 'vitest';
import { TRANSFER } from '../../../shared/config';
import { AdaptiveRateLimit } from './rate-policy';

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
