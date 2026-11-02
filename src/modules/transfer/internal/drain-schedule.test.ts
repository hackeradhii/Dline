import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { DrainSchedule } from './drain-schedule';

describe('DrainSchedule (rule 6)', () => {
  it('is due once files have gone out for `baseValidateMs` with no clean sample, not before', () => {
    const drains = new DrainSchedule(true);
    expect(drains.due(FLOW.baseValidateMs - 1, 0, 0)).toBe(false);
    expect(drains.due(FLOW.baseValidateMs, 0, 0)).toBe(true);
    expect(drains.due(FLOW.baseValidateMs, 5_000, 0)).toBe(false); // A clean sample since.
    expect(drains.due(FLOW.baseValidateMs, 0, null)).toBe(false); // Not sending.
  });

  it('never runs where drains aren’t allowed (shadow mode)', () => {
    expect(new DrainSchedule(false).due(10 * FLOW.baseValidateMs, 0, 0)).toBe(false);
  });

  it('holds for at most `drainMaxMs`, and is not due again while one is in progress', () => {
    const drains = new DrainSchedule(true);
    drains.begin('controlled', 500, 400, 1_000);
    expect(drains.active).toEqual({ from: 'controlled', rate: 500, delivery: 400, until: 1_000 + FLOW.drainMaxMs });
    expect(drains.due(FLOW.baseValidateMs * 2, 0, 0)).toBe(false);
  });

  it('a failed drain is retried after `drainRetryMs`; finishing returns where it came from', () => {
    const drains = new DrainSchedule(true);
    const at = FLOW.baseValidateMs;
    drains.begin('unlimited', 0, 900, at);
    expect(drains.finish(false, at)).toMatchObject({ from: 'unlimited', delivery: 900 });
    expect(drains.active).toBeNull();
    expect(drains.due(at + FLOW.drainRetryMs - 1, 0, 0)).toBe(false);
    expect(drains.due(at + FLOW.drainRetryMs, 0, 0)).toBe(true);
    expect(drains.finish(true, at)).toBeNull(); // Nothing in progress.
  });

  it('after a reset while sending the base is suspect: due at once, until a clean sample or a validated drain', () => {
    const drains = new DrainSchedule(true);
    drains.suspect(1_000);
    expect(drains.due(1_000, 0, 0)).toBe(true);
    expect(drains.due(1_000, 1_500, 0)).toBe(false); // Clean since the reset.
    drains.begin('controlled', 1, 1, 1_000);
    drains.finish(true, 1_100);
    expect(drains.due(1_200, 0, 0)).toBe(false);
  });
});
