import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { SimControl } from '../../../shared/testing/fake-bottleneck';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { FlowController } from './flow-controller';
import { FlowTrace } from './flow-trace';
import { ValidationDrain } from './validation-drain';

/** A drain over lanes 0 and 3, a real controller, and an estimator and probe that record what they were asked. */
function setup() {
  const clock = new FakeClock();
  const control = SimControl.linked(
    (arrive) => arrive(),
    (arrive) => arrive(),
  );
  const controller = new FlowController({ now: () => clock.now(), pacerWaitAt: () => clock.now(), drains: true });
  const calls: string[] = [];
  const marks: number[] = [];
  const trace = new FlowTrace();
  const drain = new ValidationDrain({
    controller,
    estimator: { cleanFrom: (at) => calls.push(`clean from ${at}`), stopCleaning: () => calls.push('stop cleaning') },
    probe: { probeNow: () => calls.push('probe') },
    trace,
    control: control.a,
    clock,
    mark: (m) => {
      marks.push(m);
      return [0, 3];
    },
    changed: () => undefined,
  });
  /** The receiver read marker `m` on lane `n`. */
  const answer = (m: number, n: number) => control.b.send({ t: 'flow-mark', m, n });
  return { clock, controller, drain, trace, calls, marks, answer };
}

describe('ValidationDrain (rule 6)', () => {
  it('holds, marks every lane, and once all have answered takes the next samples as clean', () => {
    const t = setup();
    t.clock.advance(1_000);
    t.drain.start(t.clock.now());
    expect(t.controller.limit).toBe(0);
    expect(t.marks).toEqual([1]);
    t.answer(1, 0);
    expect(t.calls).toEqual([]);
    t.answer(1, 3);
    expect(t.calls).toEqual(['clean from 1000', 'probe']);
    t.clock.advance(200);
    t.drain.end(true);
    expect(t.controller.state).toBe('unlimited');
    expect(t.trace.drains).toEqual([{ start: 1_000, end: 1_200, validated: true }]);
  });

  it('ends unvalidated at the hold’s deadline, and stops cleaning', () => {
    const t = setup();
    t.drain.start(t.clock.now());
    t.clock.advance(FLOW.drainMaxMs - 1);
    expect(t.controller.state).toBe('draining');
    t.clock.advance(1);
    expect(t.controller.state).toBe('controlled');
    expect(t.calls).toEqual(['stop cleaning']);
    expect(t.trace.drains).toEqual([{ start: 0, end: FLOW.drainMaxMs, validated: false }]);
  });

  it('a lane closing before it answered fails the drain at once', () => {
    const t = setup();
    t.drain.start(t.clock.now());
    t.answer(1, 0);
    t.drain.laneClosed(3);
    expect(t.controller.state).toBe('controlled');
    expect(t.trace.drains[0]?.validated).toBe(false);
  });

  it('ignores answers and deadlines once it has ended', () => {
    const t = setup();
    t.drain.start(t.clock.now());
    t.drain.end(true);
    t.answer(1, 0);
    t.answer(1, 3);
    t.clock.advance(FLOW.drainMaxMs);
    expect(t.calls).toEqual([]);
    expect(t.trace.drains).toHaveLength(1);
  });
});
