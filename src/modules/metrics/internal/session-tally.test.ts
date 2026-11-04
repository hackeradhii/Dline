import { describe, expect, it } from 'vitest';
import type { TransferDirection } from '../../../contracts/transfer';
import { METRICS } from '../../../shared/config';
import { SessionTally, type TallyItem } from './session-tally';

const MB = 1_000_000;
const item = (id: string, bytes: number, timing: { startedAt?: number | null; elapsedMs?: number; status?: string; direction?: TransferDirection } = {}): TallyItem => ({
  id,
  direction: timing.direction ?? 'out',
  bytes,
  status: timing.status ?? 'transferring',
  startedAt: timing.startedAt === undefined ? 0 : timing.startedAt,
  elapsedMs: timing.elapsedMs ?? 0,
});

/** One stats tick, a second after the last. */
const second = (tally: SessionTally) => tally.tick(1000);

describe('SessionTally', () => {
  it('turns file progress into a live speed, both ways apart', () => {
    const tally = new SessionTally();
    let snapshot = second(tally);
    for (let s = 1; s <= METRICS.liveWindowTicks; s++) {
      tally.observe(item('a', s * MB));
      tally.observe(item('b', s * MB * 2, { direction: 'in' }));
      snapshot = second(tally);
    }
    expect(snapshot.up.bps).toBeCloseTo(MB, 0);
    expect(snapshot.down.bps).toBeCloseTo(2 * MB, 0);
    expect(snapshot.up.bytes).toBe(METRICS.liveWindowTicks * MB);
    expect(snapshot.up.history.at(-1)).toBeCloseTo(MB, 0);
  });

  it('averages over the time files moved, overlaps once, so idle minutes and parallel files are counted right', () => {
    const tally = new SessionTally();
    // Two files side by side over 0-2 s, then a third over 62-64 s: 4 s of moving time in all.
    tally.observe(item('a', 3 * MB, { startedAt: 0, elapsedMs: 2_000, status: 'done' }));
    tally.observe(item('b', 1 * MB, { startedAt: 1_000, elapsedMs: 1_000, status: 'done' }));
    tally.observe(item('c', 4 * MB, { startedAt: 62_000, elapsedMs: 2_000, status: 'done' }));
    tally.observe(item('d', 0, { startedAt: null, status: 'queued' }));
    expect(tally.snapshot().up.avgBps).toBeCloseTo((8 * MB) / 4, 0);
  });

  it('keeps the busiest second as the peak, never below the average (a burst shorter than a second)', () => {
    const tally = new SessionTally();
    tally.observe(item('a', 200_000, { elapsedMs: 15, status: 'done' }));
    second(tally);
    for (let s = 0; s < 60; s++) second(tally);
    const { up } = tally.snapshot();
    expect(up.avgBps).toBeCloseTo(200_000 / 0.015, 0);
    expect(up.peakBps).toBe(up.avgBps);
    expect(up.bps).toBe(0);
    expect(up.history).toHaveLength(METRICS.historyTicks);
  });

  it('counts each finished file once: done as a file, failed apart, cancelled as neither', () => {
    const tally = new SessionTally();
    tally.observe(item('a', MB, { status: 'done' }));
    tally.observe(item('a', MB, { status: 'done' }));
    tally.observe(item('b', 10, { status: 'failed' }));
    tally.observe(item('c', 10, { status: 'cancelled' }));
    expect(tally.snapshot().up).toMatchObject({ files: 1, failed: 1, bytes: MB + 20 });
  });
});
