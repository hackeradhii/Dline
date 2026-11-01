import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { CallReserve } from './call-reserve';

describe('CallReserve (PLAN.md §5.4)', () => {
  it('measures the bottleneck while it stays busy: files plus media, over that time', () => {
    const reserve = new CallReserve();
    expect(reserve.capacity(0)).toBeNull();
    reserve.busy(80_000, 100, 2_400_000, 1_000); // 80 kB of files and 300 kB/s of media in 100 ms: 1.1 MB/s.
    expect(reserve.capacity(1_000)).toBeNull(); // Not busy for long enough to tell.
    reserve.busy(60_000, 100, 2_400_000, 1_100); // 0.9 MB/s.
    expect(reserve.capacity(1_100)).toBe(1_000_000); // What it carried over the busy time, not the stretch that read highest.
  });

  it('follows the bottleneck: only the last 5 s count', () => {
    const reserve = new CallReserve();
    reserve.busy(400_000, 200, 0, 1_000); // 2 MB/s.
    reserve.busy(200_000, 200, 0, 1_000 + FLOW.capacityWindowMs);
    expect(reserve.capacity(1_000 + FLOW.capacityWindowMs)).toBe(1_000_000);
  });

  it('trusts the last measurement for 30 s once the queue is gone', () => {
    const reserve = new CallReserve();
    reserve.busy(200_000, 200, 0, 1_000);
    expect(reserve.capacity(1_000 + FLOW.capacityMaxAgeMs)).toBe(1_000_000);
    expect(reserve.capacity(1_000 + FLOW.capacityMaxAgeMs + 1)).toBeNull();
  });

  it('keeps headroom over the media’s rate, or over the 720p ceiling (64 kbit/s for audio) while below it, at most 70 % of the bottleneck', () => {
    const reserve = new CallReserve();
    const capacity = 10_000_000;
    expect(reserve.reserve(4_000_000, true, capacity)).toBe((FLOW.mediaHeadroom * 4_000_000) / 8);
    // A video that backed off to 1.8 Mbit/s keeps room to come back to its ceiling, and some.
    expect(reserve.reserve(1_800_000, true, capacity)).toBe((FLOW.mediaHeadroom * FLOW.videoReserveBps) / 8);
    expect(reserve.reserve(0, false, capacity)).toBe((FLOW.mediaHeadroom * FLOW.audioReserveBps) / 8);
    expect(reserve.reserve(4_000_000, true, 500_000)).toBe(FLOW.maxReserveShare * 500_000);
  });

  it('starts over on reset', () => {
    const reserve = new CallReserve();
    reserve.busy(200_000, 200, 0, 1_000);
    reserve.reset();
    expect(reserve.capacity(1_000)).toBeNull();
  });
});
