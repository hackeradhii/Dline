import { describe, expect, it } from 'vitest';
import type { ControlOf } from '../../../contracts/control';
import { FLOW } from '../../../shared/config';
import { SimControl } from '../../../shared/testing/fake-bottleneck';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { FlowResponder } from './flow-responder';

const ONE_WAY_MS = 10;

/** A responder on side b; side a sends probes by hand and records the answers. */
function setup() {
  const clock = new FakeClock();
  const delay = (arrive: () => void) => void clock.setTimeout(arrive, ONE_WAY_MS);
  const control = SimControl.linked(delay, delay);
  const responder = new FlowResponder(control.b, clock);
  const echoes: Array<ControlOf<'flow-echo'>> = [];
  const marks: Array<ControlOf<'flow-mark'>> = [];
  control.a.on('flow-echo', (m) => echoes.push(m));
  control.a.on('flow-mark', (m) => marks.push(m));
  const probe = (s: number) => control.a.send({ t: 'flow-probe', s, ts: clock.now() });
  return { clock, responder, echoes, marks, probe };
}

describe('FlowResponder', () => {
  it('echoes a probe at once, with its own arrival time and the bulk bytes received so far', () => {
    const t = setup();
    t.responder.received(1_000);
    t.responder.received(24);
    t.clock.advance(0.06);
    t.probe(7);
    t.clock.advance(2 * ONE_WAY_MS + 1);
    expect(t.echoes).toEqual([{ t: 'flow-echo', s: 7, ts: 0.06, ra: 10.1, rb: 1_024 }]); // Times go out at 0.1 ms.
  });

  it('answers at most one probe per 10 ms, so a peer can’t make it echo without bound', () => {
    const t = setup();
    for (let s = 0; s < 100; s++) t.probe(s);
    t.clock.advance(2 * ONE_WAY_MS);
    expect(t.echoes.map((e) => e.s)).toEqual([0]);

    for (let s = 100; s < 150; s++) {
      t.probe(s);
      t.clock.advance(1);
    }
    t.clock.advance(2 * ONE_WAY_MS);
    const arrivals = t.echoes.map((e) => e.ra);
    expect(arrivals).toHaveLength(6);
    arrivals.slice(1).forEach((ra, i) => expect(ra - arrivals[i]!).toBeGreaterThanOrEqual(FLOW.minEchoGapMs));
  });

  it('answers a drain marker with the marker and the lane it came on', () => {
    const t = setup();
    t.responder.marked(3, 5);
    t.clock.advance(ONE_WAY_MS);
    expect(t.marks).toEqual([{ t: 'flow-mark', m: 3, n: 5 }]);
  });

  it('stops answering once disposed', () => {
    const t = setup();
    t.responder.dispose();
    t.probe(0);
    t.clock.advance(2 * ONE_WAY_MS);
    expect(t.echoes).toEqual([]);
  });
});
