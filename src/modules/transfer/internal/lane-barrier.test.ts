import { describe, expect, it } from 'vitest';
import { LaneBarrier } from './lane-barrier';

/** A barrier over lanes `open`; records the markers it put out and how each attempt ended. */
function setup(open: number[]) {
  const marked: number[] = [];
  const barrier = new LaneBarrier((m) => {
    marked.push(m);
    return [...open];
  });
  const outcomes: string[] = [];
  barrier.events.on('passed', () => outcomes.push('passed'));
  barrier.events.on('failed', () => outcomes.push('failed'));
  return { barrier, marked, outcomes };
}

describe('LaneBarrier (FLOW-14)', () => {
  it('passes once every lane that carried the marker has answered it', () => {
    const t = setup([0, 2, 5]);
    t.barrier.start();
    t.barrier.answered(1, 0);
    t.barrier.answered(1, 5);
    expect(t.outcomes).toEqual([]);
    t.barrier.answered(1, 2);
    expect(t.outcomes).toEqual(['passed']);
  });

  it('passes at once when no lane is open', () => {
    const t = setup([]);
    t.barrier.start();
    expect(t.outcomes).toEqual(['passed']);
  });

  it('ignores answers to an older marker, from lanes it didn’t ask, and repeats', () => {
    const t = setup([1, 2]);
    t.barrier.start();
    t.barrier.cancel();
    t.barrier.start();
    expect(t.marked).toEqual([1, 2]);
    t.barrier.answered(1, 1);
    t.barrier.answered(1, 2);
    t.barrier.answered(2, 7);
    t.barrier.answered(2, 1);
    t.barrier.answered(2, 1);
    expect(t.outcomes).toEqual([]);
    t.barrier.answered(2, 2);
    expect(t.outcomes).toEqual(['passed']);
  });

  it('fails when a lane closes before answering; lanes that answered, or were never asked, may close', () => {
    const t = setup([1, 2]);
    t.barrier.start();
    t.barrier.answered(1, 1);
    t.barrier.laneClosed(1);
    t.barrier.laneClosed(9);
    expect(t.outcomes).toEqual([]);
    t.barrier.laneClosed(2);
    expect(t.outcomes).toEqual(['failed']);
    t.barrier.answered(1, 2); // Too late: nothing is certified.
    expect(t.outcomes).toEqual(['failed']);
  });

  it('does nothing once cancelled', () => {
    const t = setup([1]);
    t.barrier.start();
    t.barrier.cancel();
    t.barrier.answered(1, 1);
    t.barrier.laneClosed(1);
    expect(t.outcomes).toEqual([]);
  });
});
