import { describe, expect, it } from 'vitest';
import { wireMs } from '../../../contracts/flow';
import { FLOW } from '../../../shared/config';
import { SimControl } from '../../../shared/testing/fake-bottleneck';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { alwaysVisible } from '../../../shared/timer';
import { FlowResponder } from './flow-responder';
import { FlowSession } from './flow-session';
import type { PacingMode } from './pacing-selector';

const ONE_WAY_MS = 10;
const LEGACY = 300_000;

/** A session on side a; side b answers like a current peer, unless the test answers itself. `path.forwardMs` is the probes' one-way delay. */
function setup(mode: PacingMode, { answer = true, forwardMs = ONE_WAY_MS } = {}) {
  const clock = new FakeClock();
  const path = { forwardMs };
  const control = SimControl.linked(
    (arrive) => void clock.setTimeout(arrive, path.forwardMs),
    (arrive) => void clock.setTimeout(arrive, ONE_WAY_MS),
  );
  if (answer) new FlowResponder(control.b, clock);
  let probes = 0;
  control.b.on('flow-probe', () => probes++);
  const session = new FlowSession({
    mode,
    control: control.a,
    legacy: { limit: LEGACY },
    clock,
    visibility: alwaysVisible,
    mark: () => [],
    pacerWaitAt: () => clock.now(),
    laneCount: () => 0,
    changed: () => undefined,
  });
  return { clock, control, path, session, probes: () => probes };
}

describe('FlowSession (PLAN.md §5)', () => {
  it('legacy: only answers the peer; no probes, today’s budget', () => {
    const t = setup('legacy');
    const echoes: number[] = [];
    t.control.b.on('flow-echo', (m) => echoes.push(m.s));
    t.control.b.send({ t: 'flow-probe', s: 4, ts: 0 });
    t.clock.advance(10_000);
    expect(t.probes()).toBe(0);
    expect(echoes).toEqual([4]);
    expect(t.session.status).toEqual({ mode: 'legacy', flowInCharge: false, limit: LEGACY, queueMs: null, pingMs: null });
  });

  it('shows the probe round trip and the upload queue while samples are fresh', () => {
    const t = setup('flow');
    t.clock.advance(100);
    expect(t.session.status).toEqual({ mode: 'flow', flowInCharge: true, limit: null, queueMs: 0, pingMs: 2 * ONE_WAY_MS });
    t.control.b.mute.add('flow-echo');
    t.clock.advance(FLOW.livePingMs + 1);
    expect(t.session.status).toMatchObject({ queueMs: null, pingMs: null });
  });

  it('forgets what it learned about the old path when the path changes', () => {
    const t = setup('flow');
    t.session.setInputs({ pathKey: 'pair-1' });
    t.clock.advance(3_000);
    t.path.forwardMs = 60; // A 50 ms forward queue builds.
    t.clock.advance(8_000);
    t.session.setInputs({ pathKey: 'pair-1' }); // The same path: nothing changes.
    t.clock.advance(1_000);
    expect(t.session.status.queueMs).toBeGreaterThan(45);

    t.session.setInputs({ pathKey: 'pair-2' });
    t.clock.advance(1_000);
    expect(t.session.status.queueMs).toBe(0); // The new path's own delay is its base.
  });

  it('tells a near path from a far one by the shorter of the probes’ and ICE’s round trips, per path', () => {
    // On localhost, pages busy setting up lanes made the probes' round trip 25-58 ms, while ICE's stayed under 1 ms.
    const t = setup('flow', { forwardMs: 30 }); // The probes' round trip: 40 ms, far.
    t.clock.advance(2_000);
    t.session.setInputs({ pathKey: 'pair-1', pathRttMs: 1 });
    t.session.sending(true);
    expect(t.session.status.limit).toBeNull(); // Near: unlimited (rule 1).
    t.session.sending(false);

    t.session.setInputs({ pathKey: 'pair-2' }); // A new path: ICE hasn't measured it yet.
    t.clock.advance(2_000);
    t.session.sending(true);
    expect(t.session.status.limit).toBe(FLOW.startBytesPerSecond); // Far by the probes: the gentle start.
  });

  it('starts over after 5 s without an echo while sending, and then validates the base before trusting it', () => {
    const t = setup('flow');
    t.clock.advance(100);
    t.session.sending(true);
    t.clock.advance(1_000);
    t.control.b.mute.add('flow-echo');
    t.path.forwardMs = 60; // Meanwhile the path got slower, so the old base would read a 50 ms queue.
    t.clock.advance(FLOW.resetAfterGapMs + 1_000);
    t.control.b.mute.delete('flow-echo');
    t.clock.advance(1_000);
    expect(t.session.trace.drains).toEqual([expect.objectContaining({ validated: true })]);
    expect(t.session.status.queueMs).toBe(0);
  });

  it('sending unlimited when the echoes stop: 5 s on, a drain stops new writes at once, and with no echo it ends in a bounded rate', () => {
    const t = setup('flow'); // Near: unlimited, where halving does nothing.
    t.clock.advance(100);
    t.session.sending(true);
    t.clock.advance(1_000);
    expect(t.session.status.limit).toBeNull();
    t.control.b.mute.add('flow-echo'); // A queue deep enough to hold every echo back.
    t.clock.advance(FLOW.resetAfterGapMs);
    expect(t.session.status.limit).toBe(0);
    t.clock.advance(FLOW.drainMaxMs);
    expect(t.session.trace.drains).toEqual([expect.objectContaining({ validated: false })]);
    expect(t.session.status.limit).toBeGreaterThan(0); // No longer unlimited.
  });

  it('watches for echoes from the first byte of a transfer, not its first echo: they may have stopped in between (rule 8)', () => {
    const t = setup('flow', { forwardMs: 30 }); // Far: the gentle start, a controlled rate.
    t.clock.advance(100);
    t.session.sending(true);
    t.clock.advance(2_000);
    t.session.sending(false);
    const rate = t.session.status.limit!;
    t.control.b.mute.add('flow-echo'); // The echoes stop between transfers.
    t.clock.advance(2_000);
    t.session.sending(true);
    t.clock.advance(FLOW.feedbackTimeoutMs);
    expect(t.session.status.limit).toBe(rate / 2);
    t.clock.advance(FLOW.resetAfterGapMs - FLOW.feedbackTimeoutMs - 1);
    expect(t.session.status.limit).toBeGreaterThan(0); // 5 s count from the start, not from the last echo (7 s ago).
    t.clock.advance(1);
    expect(t.session.status.limit).toBe(0); // Started over, and validating the base.
  });

  it.each([300, FLOW.feedbackTimeoutMs + 100])('ignores the delay of probes held up behind a retransmission (Karn’s rule): a %d ms wait', (waitMs) => {
    const t = setup('flow', { answer: false });
    const held: Array<{ s: number; ts: number }> = [];
    let stalled = false;
    const echo = (s: number, ts: number) => t.control.b.send({ t: 'flow-echo', s, ts, ra: wireMs(t.clock.now()), rb: 0 });
    t.control.b.on('flow-probe', ({ s, ts }) => (stalled ? held.push({ s, ts }) : echo(s, ts)));
    t.clock.advance(100);
    t.session.sending(true);
    t.clock.advance(2_000);
    stalled = true; // `ctrl` waits behind a lost packet (on the bench for 250-700 ms, mostly under the feedback gap)...
    t.clock.advance(waitMs);
    stalled = false; // ...then the retransmission lands, and every probe held behind it arrives at once.
    for (const p of held) echo(p.s, p.ts);
    t.clock.advance(1_000);
    expect(held.length).toBeGreaterThan(FLOW.jitterSamples);
    expect(Math.max(...t.session.trace.records.map((r) => r.qdAvg))).toBeLessThan(5);
  });

  it('shadow: Flow decides beside today’s budget, which stays in force, and never drains', () => {
    const t = setup('shadow');
    t.clock.advance(100);
    t.session.sending(true);
    t.clock.advance(FLOW.baseValidateMs + 5_000);
    expect(t.session.selector.limit).toBe(LEGACY);
    expect(t.session.trace.records.length).toBeGreaterThan(100);
    expect(t.session.trace.records.at(-1)).toMatchObject({ mode: 'shadow', legacy: LEGACY, applied: LEGACY, rate: null });
    expect(t.session.trace.drains).toEqual([]);
  });
});
