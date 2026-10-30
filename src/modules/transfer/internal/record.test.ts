import { describe, expect, it } from 'vitest';
import { formatDuration } from '../../../shared/format';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { TransferRecord, type TransferItem } from './record';

describe('TransferRecord timing', () => {
  it('measures real time from first byte to verified, and freezes it when finished', () => {
    const clock = new FakeClock();
    const items: TransferItem[] = [];
    const record = new TransferRecord({ id: 'x', direction: 'out', name: 'a.mp4', size: 3_000_000, mime: 'video/mp4' }, (i) => items.push(i), clock);

    clock.advance(5_000); // Queued time does not count.
    record.update({ status: 'transferring' });
    clock.advance(1_200);
    record.progress(1_500_000);
    expect(items.at(-1)?.elapsedMs).toBe(1_200);

    clock.advance(1_000);
    record.update({ status: 'verifying' });
    clock.advance(300);
    record.update({ status: 'done', verified: true });
    expect(items.at(-1)).toMatchObject({ status: 'done', elapsedMs: 2_500 });

    clock.advance(10_000);
    record.update({ status: 'failed' }); // Ignored once finished.
    expect(items.at(-1)?.elapsedMs).toBe(2_500);
  });
});

describe('formatDuration', () => {
  it.each([
    [450, '450 ms'],
    [3_240, '3.2s'],
    [25_000, '25s'],
    [80_000, '1m 20s'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
