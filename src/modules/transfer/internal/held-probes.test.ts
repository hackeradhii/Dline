import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { FakeVisibility } from '../../../shared/testing/fake-clock';
import { feedbackGapMs } from './feedback-watch';
import type { FlowSample } from './flow-probe';
import { HeldProbes } from './held-probes';

const LATE = FLOW.heldGapProbes * FLOW.probeIntervalMs;

/** An echo arriving at `at` for a probe sent 20 ms before, with `rxBytes` delivered by `rxAt`. */
const echo = (at: number, rxBytes = 0, rxAt = at): FlowSample => ({ at, sentAt: at - 20, rttMs: 20, owdMs: 10, rxBytes, rxAt, idle: false });

describe('HeldProbes (Karn’s rule)', () => {
  it('an echo this late marks every probe sent before it as held', () => {
    const held = new HeldProbes(new FakeVisibility());
    held.echo(echo(1_000), 20);
    held.echo(echo(1_000 + LATE - 1), 20); // On time.
    expect(held.held(echo(1_000 + LATE - 1))).toBe(false);
    const late = echo(1_000 + 2 * LATE);
    held.echo(late, 20);
    expect(held.held(echo(late.at - 1))).toBe(true); // Sent before the late echo came.
    expect(held.held(echo(late.at + 40))).toBe(false);
  });

  it('judges lateness only between echoes while sending', () => {
    const held = new HeldProbes(new FakeVisibility());
    held.echo(echo(1_000), 20);
    held.sending(); // Stopped, then started again much later.
    held.echo(echo(1_000 + 10 * LATE), 20);
    expect(held.held(echo(1_000 + 10 * LATE - 1))).toBe(false);
  });

  it('in a hidden tab, late means a feedback gap: probes follow the echoes there', () => {
    const visibility = new FakeVisibility();
    visibility.set(false);
    const held = new HeldProbes(visibility);
    held.echo(echo(1_000), 20);
    held.echo(echo(1_000 + feedbackGapMs(20) - 1), 20);
    expect(held.held(echo(1_000))).toBe(false);
  });

  it('counts what arrived between two echoes, unless a held probe lies between them', () => {
    const held = new HeldProbes(new FakeVisibility());
    expect(held.since(null, echo(100, 5_000))).toBeNull();
    expect(held.since(echo(100, 5_000), echo(140, 9_000))).toEqual({ bytes: 4_000, ms: 40 });
    expect(held.since(echo(140, 9_000), echo(180, 9_000, 140))).toBeNull(); // No time passed at the receiver.
    held.echo(echo(1_000), 20);
    held.echo(echo(1_000 + 2 * LATE), 20);
    expect(held.since(echo(1_000, 0), echo(1_000 + 2 * LATE + 40, 8_000))).toBeNull();
  });
});
