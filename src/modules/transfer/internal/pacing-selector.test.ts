import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { flush } from '../../../shared/testing/drive';
import { SimControl } from '../../../shared/testing/fake-bottleneck';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { FlowController } from './flow-controller';
import { FlowProbe } from './flow-probe';
import { FlowResponder } from './flow-responder';
import { PacingSelector, type PacingMode } from './pacing-selector';

const ONE_WAY_MS = 10;
const LEGACY = 300_000;

/** A selector over a fixed legacy budget and Flow's real parts; `answers`: the other device echoes probes. */
function setup(mode: PacingMode, { answers = true } = {}) {
  const clock = new FakeClock();
  const delay = (arrive: () => void) => void clock.setTimeout(arrive, ONE_WAY_MS);
  const control = SimControl.linked(delay, delay);
  if (answers) new FlowResponder(control.b, clock);
  const probe = mode === 'legacy' ? null : new FlowProbe(control.a, clock, () => -Infinity);
  const flow = mode === 'legacy' ? null : new FlowController({ now: () => clock.now(), pacerWaitAt: () => clock.now(), drains: mode === 'flow' });
  const selector = new PacingSelector({ mode, legacy: { limit: LEGACY }, flow, probe, clock });
  /** Calls `ready()`; `done` turns true once it resolves. */
  const ready = () => {
    const call = { done: false };
    void selector.ready().then(() => {
      call.done = true;
    });
    return call;
  };
  /** Advances the clock, then lets promises settle. */
  const after = async (ms: number) => {
    clock.advance(ms);
    await flush();
  };
  return { clock, flow, probe, selector, ready, after };
}

describe('PacingSelector (PLAN.md §5.6)', () => {
  it('legacy: today’s budget, per block', async () => {
    const t = setup('legacy');
    expect(t.selector).toMatchObject({ mode: 'legacy', flowInCharge: false, actuator: 'block', limit: LEGACY });
    const call = t.ready();
    await t.after(0);
    expect(call.done).toBe(true);
  });

  it('shadow: today’s budget, even with a peer that answers', async () => {
    const t = setup('shadow');
    t.clock.advance(100);
    expect(t.probe?.capability).toBe('supported');
    expect(t.selector).toMatchObject({ flowInCharge: false, actuator: 'block', limit: LEGACY });
    const call = t.ready();
    await t.after(0);
    expect(call.done).toBe(true);
  });

  it('flow: today’s pacing until the peer answers, then Flow’s budget and fine pacing', () => {
    const t = setup('flow');
    expect(t.selector).toMatchObject({ flowInCharge: false, actuator: 'block', limit: LEGACY });
    t.clock.advance(100);
    expect(t.selector).toMatchObject({ flowInCharge: true, actuator: 'fine', limit: null });
  });

  it('flow with an older peer: today’s pacing', () => {
    const t = setup('flow', { answers: false });
    t.clock.advance(FLOW.capabilityTimeoutMs + 1_000);
    expect(t.probe?.capability).toBe('unsupported');
    expect(t.selector).toMatchObject({ flowInCharge: false, actuator: 'block', limit: LEGACY });
  });

  it('never lets a hold outlive its deadline, whatever the controller does (FLOW-13)', () => {
    const t = setup('flow');
    t.clock.advance(100);
    t.flow!.startDrain(t.clock.now());
    expect(t.selector.limit).toBe(0);
    t.clock.advance(FLOW.drainMaxMs - 1);
    expect(t.selector.limit).toBe(0);
    t.clock.advance(1);
    expect(t.flow!.state).toBe('draining');
    expect(t.selector.limit).toBe(t.flow!.hold!.release);
    expect(t.selector.limit).toBeGreaterThan(0);
  });

  it('before the first block, waits for the peer’s first echo: about a round trip (FLOW-03)', async () => {
    const t = setup('flow');
    const first = t.ready();
    await t.after(2 * ONE_WAY_MS - 1);
    expect(first.done).toBe(false);
    await t.after(1);
    expect(first.done).toBe(true);
    expect(t.probe?.capability).toBe('supported');
    const next = t.ready(); // Known now: no wait.
    await t.after(0);
    expect(next.done).toBe(true);
  });

  it('waits at most a second for a peer that never answers, and only once', async () => {
    const t = setup('flow', { answers: false });
    const first = t.ready();
    await t.after(FLOW.capabilityHoldMs - 1);
    expect(first.done).toBe(false);
    await t.after(1);
    expect(first.done).toBe(true);
    expect(t.probe?.capability).toBe('unknown');
    const next = t.ready();
    await t.after(0);
    expect(next.done).toBe(true);
  });
});
