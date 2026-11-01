import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { FeedbackWatch, feedbackGapMs } from './feedback-watch';

/** A watch that records when each gap and silence came, relative to the start. */
function setup() {
  const clock = new FakeClock();
  const events: string[] = [];
  const watch = new FeedbackWatch({
    clock,
    gap: (now) => events.push(`gap ${now}`),
    silent: (now) => events.push(`silent ${now}`),
    changed: () => undefined,
  });
  return { clock, events, watch };
}

describe('FeedbackWatch (rule 8)', () => {
  it('waits the longer of a few round trips and the timeout', () => {
    expect(feedbackGapMs(0)).toBe(FLOW.feedbackTimeoutMs);
    expect(feedbackGapMs(10_000)).toBe(FLOW.feedbackGapRtts * 10_000);
  });

  it('a gap every gap while sending; one silence once nothing was heard for long enough', () => {
    const t = setup();
    const gap = feedbackGapMs(0);
    t.watch.start(0);
    t.watch.arm(0);
    t.clock.advance(FLOW.resetAfterGapMs + 3 * gap);
    const gaps = t.events.filter((e) => e.startsWith('gap'));
    expect(gaps[0]).toBe(`gap ${gap}`);
    expect(gaps.length).toBe(Math.floor((FLOW.resetAfterGapMs + 3 * gap) / gap));
    expect(t.events.filter((e) => e.startsWith('silent'))).toEqual([`silent ${Math.ceil(FLOW.resetAfterGapMs / gap) * gap}`]);
  });

  it('counts silence from the last echo, and an echo allows another silence', () => {
    const t = setup();
    t.watch.start(0);
    t.clock.advance(1_000);
    t.watch.heard(t.clock.now());
    t.watch.arm(0);
    t.clock.advance(FLOW.resetAfterGapMs - 1);
    expect(t.events.some((e) => e.startsWith('silent'))).toBe(false);
    t.clock.advance(FLOW.resetAfterGapMs);
    expect(t.events.filter((e) => e.startsWith('silent'))).toHaveLength(1);
    t.watch.heard(t.clock.now());
    t.watch.arm(0);
    t.clock.advance(FLOW.resetAfterGapMs + feedbackGapMs(0));
    expect(t.events.filter((e) => e.startsWith('silent'))).toHaveLength(2);
  });

  it('does nothing while not sending, and stops when sending stops', () => {
    const t = setup();
    t.watch.arm(0);
    t.clock.advance(FLOW.resetAfterGapMs * 2);
    expect(t.events).toEqual([]);
    t.watch.start(t.clock.now());
    t.watch.arm(0);
    t.watch.stop();
    t.clock.advance(FLOW.resetAfterGapMs * 2);
    expect(t.events).toEqual([]);
  });
});
