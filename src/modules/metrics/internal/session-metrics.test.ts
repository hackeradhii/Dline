import { describe, expect, it } from 'vitest';
import type { MetricsEvent, MetricsOf } from '../../../contracts/metrics';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { MetricsReporter, type ReportContext } from './reporter';
import { SessionMetrics } from './session-metrics';

const common = { session: 'abcdefgh12', role: 'host', mode: 'link', device: 'Windows Chrome 156' } as const;
const PATH = { kind: 'lan', family: 'IPv4', local: 'host', remote: 'host' } as const;
const context = (extra: Partial<ReportContext> = {}): ReportContext => ({ path: PATH, rttMs: 5, lanes: 1, call: false, pacing: 'flow', ...extra });

function setup() {
  const clock = new FakeClock();
  const sent: MetricsEvent[] = [];
  const metrics = new SessionMetrics(new MetricsReporter({ sink: { send: (e) => sent.push(e) }, enabled: true, common, clock }), clock);
  const tick = (extra?: Partial<ReportContext>) => {
    clock.advance(1000);
    return metrics.tick(context(extra));
  };
  return { sent, metrics, tick };
}

describe('SessionMetrics', () => {
  it('reports the connect on the first tick that knows the path, and a finished file in the latest context', () => {
    const { sent, metrics, tick } = setup();
    tick({ path: null });
    expect(sent).toEqual([]);
    tick({ lanes: 4 });
    metrics.transfer({ id: 'a', direction: 'in', status: 'done', error: null, size: 100, bytes: 100, startedAt: 0, elapsedMs: 1000, verified: true });
    expect(sent.map((e) => e.t)).toEqual(['connect', 'transfer']);
    expect(sent[1]).toMatchObject({ direction: 'in', lanes: 4, path: PATH });
  });

  it('sums call time, counts recoveries and keeps the most lanes for the session report, sent once', () => {
    const { sent, metrics, tick } = setup();
    tick({ call: true, lanes: 8 });
    tick({ call: true, lanes: 16 });
    tick({ call: false, lanes: 2 });
    metrics.unstable();
    metrics.end('lost');
    metrics.end('left');
    const sessions = sent.filter((e): e is MetricsOf<'session'> => e.t === 'session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ end: 'lost', ms: 3_000, callMs: 2_000, maxLanes: 16, recoveries: 1, path: PATH });
  });
});
