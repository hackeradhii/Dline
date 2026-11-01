import { describe, expect, it } from 'vitest';
import type { ControlOf } from '../../../contracts/control';
import { FLOW } from '../../../shared/config';
import { flush } from '../../../shared/testing/drive';
import { SimControl } from '../../../shared/testing/fake-bottleneck';
import { FakeClock, FakeVisibility, ThrottledClock } from '../../../shared/testing/fake-clock';
import { FlowProbe, type Capability, type FlowSample } from './flow-probe';
import { FlowResponder } from './flow-responder';

const ONE_WAY_MS = 10;

type Probe = ControlOf<'flow-probe'> & { arrived: number };

/** A probe on side a; side b records what arrives, and nothing answers unless the test says so. */
function setup({ lastWriteAt = () => -Infinity, open = true }: { lastWriteAt?: () => number; open?: boolean } = {}) {
  const clock = new FakeClock();
  const delay = (arrive: () => void) => void clock.setTimeout(arrive, ONE_WAY_MS);
  const control = SimControl.linked(delay, delay);
  control.a.isOpen = open;
  const probes: Probe[] = [];
  control.b.on('flow-probe', (m) => probes.push({ ...m, arrived: clock.now() }));
  const probe = new FlowProbe(control.a, clock, lastWriteAt);
  const samples: FlowSample[] = [];
  const capability: Capability[] = [];
  probe.events.on('sample', (s) => samples.push(s));
  probe.events.on('capability', (c) => capability.push(c));
  /** Side b answers `p` by hand, as a peer would. */
  const echo = (p: Probe, overrides: Partial<ControlOf<'flow-echo'>> = {}) =>
    control.b.send({ t: 'flow-echo', s: p.s, ts: p.ts, ra: p.arrived, rb: 0, ...overrides });
  return { clock, control, probe, probes, samples, capability, echo };
}

describe('FlowProbe: does the other device answer? (FLOW-03)', () => {
  it('probes once a second from the start, says unsupported after 5 s of silence, and a late echo still upgrades', () => {
    const t = setup();
    t.clock.advance(FLOW.capabilityTimeoutMs - 1);
    expect(t.probes.map((p) => p.ts)).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
    expect(t.probe.capability).toBe('unknown');
    t.clock.advance(1);
    expect(t.capability).toEqual(['unsupported']);

    t.probe.sending(true); // An older peer gets the slow probe only, even while files go out.
    t.clock.advance(3_000);
    expect(t.probes.slice(-3).map((p) => p.ts)).toEqual([5_000, 6_000, 7_000]);

    new FlowResponder(t.control.b, t.clock); // It turns out to answer after all.
    t.clock.advance(1_000);
    expect(t.capability).toEqual(['unsupported', 'supported']);
    expect(t.samples[0]).toMatchObject({ sentAt: 8_000, rttMs: 2 * ONE_WAY_MS, owdMs: ONE_WAY_MS, idle: false });
    const gaps = t.probes.slice(-5).map((p, i, all) => (i ? p.ts - all[i - 1]!.ts : FLOW.probeIntervalMs));
    expect(gaps).toEqual(Array(5).fill(FLOW.probeIntervalMs)); // While sending to a peer that answers: every 40 ms.
  });

  it('starts the 5 s clock at the first probe that actually went out', () => {
    const t = setup({ open: false });
    t.clock.advance(2_500); // ctrl isn't open yet: the probes fail.
    t.control.a.isOpen = true;
    t.clock.advance(500 + FLOW.capabilityTimeoutMs - 1);
    expect(t.probe.capability).toBe('unknown');
    t.clock.advance(1);
    expect(t.probe.capability).toBe('unsupported');
  });

  it('ignores stale, duplicate and foreign echoes', () => {
    const t = setup();
    t.clock.advance(2_500);
    const [p0, p1, p2] = t.probes as [Probe, Probe, Probe];
    t.echo(p1);
    t.clock.advance(ONE_WAY_MS);
    expect(t.samples).toHaveLength(1);

    t.echo(p1); // A duplicate.
    t.echo(p0); // Older than one already answered.
    t.echo(p2, { ts: p2.ts + 1 }); // Not the time it was sent with.
    t.echo({ ...p2, s: 99 }); // Never sent.
    t.clock.advance(ONE_WAY_MS);
    expect(t.samples).toHaveLength(1);

    t.echo(p2);
    t.clock.advance(ONE_WAY_MS);
    expect(t.samples).toHaveLength(2);
  });

  it('forgets unanswered probes sent more than 10 s ago', () => {
    const t = setup();
    t.clock.advance(20_000 + ONE_WAY_MS);
    expect(t.probes).toHaveLength(21);
    const sentAt = (ts: number) => t.probes.find((p) => p.ts === ts)!;
    t.echo(sentAt(20_000 - FLOW.probeMaxAgeMs - 1_000));
    t.clock.advance(ONE_WAY_MS);
    expect(t.samples).toHaveLength(0);
    t.echo(sentAt(20_000 - FLOW.probeMaxAgeMs));
    t.clock.advance(ONE_WAY_MS);
    expect(t.samples).toHaveLength(1);
  });

  it('still matches echoes that a deep queue holds back for seconds while sending', () => {
    // A full 3 s phone uplink buffer: counting only the last 64 probes (2.6 s at 40 ms) dropped every echo.
    const t = setup();
    let queueMs = 0;
    t.control.b.on('flow-probe', (m) => void t.clock.setTimeout(() => t.echo({ ...m, arrived: t.clock.now() }), queueMs));
    t.clock.advance(100); // The peer answers.
    t.probe.sending(true);
    queueMs = 3_500;
    t.clock.advance(10_000);
    expect(t.samples.filter((s) => s.rttMs > 3_000).length).toBeGreaterThan(100); // One every 40 ms once they come back.
  });

  it('marks a probe sent with nothing going out for a second as having crossed an idle path', () => {
    let lastWriteAt = -Infinity;
    const t = setup({ lastWriteAt: () => lastWriteAt });
    new FlowResponder(t.control.b, t.clock);
    t.clock.advance(100);
    expect(t.samples.at(-1)?.idle).toBe(true);

    lastWriteAt = t.clock.now(); // A block just went to a lane.
    t.probe.probeNow();
    t.clock.advance(100);
    expect(t.samples.at(-1)?.idle).toBe(false);

    t.clock.advance(FLOW.idleCleanMs);
    t.probe.probeNow();
    t.clock.advance(100);
    expect(t.samples.at(-1)?.idle).toBe(true);

    t.probe.sending(true); // Blocks queued or unacknowledged: never idle.
    t.clock.advance(FLOW.idleCleanMs + 100);
    expect(t.samples.at(-1)?.idle).toBe(false);
  });

  it('probes on acks once the interval has passed, so a hidden tab’s slow timers keep the cadence', async () => {
    const visibility = new FakeVisibility();
    const clock = new ThrottledClock(visibility);
    visibility.set(false); // Timers wait at least a second.
    const control = SimControl.linked(queueMicrotask, queueMicrotask);
    let sent = 0;
    control.b.on('flow-probe', () => sent++);
    new FlowResponder(control.b, clock);
    const probe = new FlowProbe(control.a, clock, () => -Infinity);
    await flush();
    expect(probe.capability).toBe('supported');
    probe.sending(true);

    sent = 0;
    clock.advance(FLOW.probeIntervalMs / 2);
    probe.acked();
    await flush();
    expect(sent).toBe(0); // Too soon after the last one.
    clock.advance(FLOW.probeIntervalMs / 2);
    probe.acked();
    probe.acked();
    await flush();
    expect(sent).toBe(1);
    clock.advance(500);
    await flush();
    expect(sent).toBe(1); // The throttled timer hasn't fired.
  });

  it('in a hidden tab, while sending, the echo of its latest probe brings the next one', () => {
    const visibility = new FakeVisibility();
    const clock = new ThrottledClock(visibility);
    const oneWay = (arrive: () => void) => clock.network(arrive, ONE_WAY_MS);
    const control = SimControl.linked(oneWay, oneWay);
    new FlowResponder(control.b, clock);
    let sent = 0;
    control.b.on('flow-probe', () => sent++);
    const probe = new FlowProbe(control.a, clock, () => -Infinity, visibility);
    clock.advance(100);
    expect(probe.capability).toBe('supported');
    probe.sending(true);
    visibility.set(false); // From now on timers wait at least a second.
    sent = 0;
    clock.advance(1_000);
    // About one probe a round trip (20 ms): a single chain, not one more per echo.
    expect(sent).toBeGreaterThanOrEqual(45);
    expect(sent).toBeLessThanOrEqual(1_000 / (2 * ONE_WAY_MS) + 2);

    probe.sending(false); // Done sending: back to the slow probe.
    sent = 0;
    clock.advance(3_000);
    expect(sent).toBeLessThanOrEqual(4);
  });

  it('stops probing once disposed', () => {
    const t = setup();
    t.clock.advance(1_500);
    t.probe.dispose();
    t.clock.advance(10_000);
    expect(t.probes).toHaveLength(2);
    expect(t.capability).toEqual([]);
  });
});
