import { describe, expect, it } from 'vitest';
import type { MetricsEvent } from '../../../contracts/metrics';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { MetricsReporter, type FinishedTransfer, type ReportContext, type SessionTotals } from './reporter';

const common = { session: 'abcdefgh12', role: 'guest', mode: 'rendezvous', device: 'iOS Safari 26.6' } as const;
const PATH = { kind: 'internet', family: 'IPv6', local: 'srflx', remote: 'prflx' } as const;
const CONTEXT: ReportContext = { path: PATH, rttMs: 60.4, lanes: 16, call: true, pacing: 'flow' };
const finished = (id: string, extra: Partial<FinishedTransfer> = {}): FinishedTransfer => ({
  id,
  direction: 'out',
  status: 'done',
  error: null,
  size: 4_000_000,
  bytes: 4_000_000,
  elapsedMs: 2_000,
  verified: true,
  ...extra,
});
const SIDE = { bytes: 10.6, files: 1, failed: 0, bps: 0, avgBps: 5.4, peakBps: 9.9, history: [] };
const TOTALS: SessionTotals = { end: 'left', ms: 5_000, up: SIDE, down: SIDE, callMs: 0, maxLanes: 1, recoveries: 0, path: null };

function setup(enabled = true) {
  const clock = new FakeClock();
  const sent: MetricsEvent[] = [];
  const reporter = new MetricsReporter({ sink: { send: (e) => sent.push(e) }, enabled, common, clock });
  return { clock, sent, reporter };
}

describe('MetricsReporter', () => {
  it('times the connect from when both peers are present, and reports it once', () => {
    const { clock, sent, reporter } = setup();
    clock.advance(60_000); // Waiting for the guest is not connect time.
    reporter.connecting();
    clock.advance(1_500);
    reporter.connected(PATH, 60.4);
    reporter.connected(PATH, 70);
    reporter.failed(['unknown'], null, null);
    expect(sent).toEqual([{ t: 'connect', ...common, outcome: 'connected', ms: 1_500, path: PATH, rttMs: 60 }]);
  });

  it('reports a failed connect with its causes and both networks', () => {
    const { sent, reporter } = setup();
    const local = { udp: true, ipv4: 'symmetric', ipv6: false, relayOnly: false };
    reporter.failed(['unknown'], local, null);
    expect(sent).toEqual([{ t: 'connect', ...common, outcome: 'failed', ms: 0, causes: ['unknown'], local }]);
  });

  it('reports each finished transfer once, with its speed and the line it went over', () => {
    const { sent, reporter } = setup();
    reporter.transferEnded(finished('a', { status: 'transferring' }), CONTEXT);
    reporter.transferEnded(finished('a'), CONTEXT);
    reporter.transferEnded(finished('a'), CONTEXT);
    expect(sent).toEqual([
      {
        t: 'transfer',
        ...common,
        direction: 'out',
        status: 'done',
        size: 4_000_000,
        bytes: 4_000_000,
        ms: 2_000,
        bps: 2_000_000,
        verified: true,
        lanes: 16,
        call: true,
        pacing: 'flow',
        path: PATH,
        rttMs: 60,
      },
    ]);
  });

  it('reports the session once, rounded', () => {
    const { sent, reporter } = setup();
    reporter.sessionEnded(TOTALS);
    reporter.sessionEnded(TOTALS);
    const side = { bytes: 11, files: 1, failed: 0, avgBps: 5, peakBps: 10 };
    expect(sent).toEqual([{ t: 'session', ...common, end: 'left', ms: 5_000, up: side, down: side, callMs: 0, maxLanes: 1, recoveries: 0 }]);
  });

  it('sends nothing at all when the user turned reports off', () => {
    const { sent, reporter } = setup(false);
    reporter.connected(PATH, 1);
    reporter.transferEnded(finished('a'), CONTEXT);
    reporter.sessionEnded(TOTALS);
    expect(sent).toEqual([]);
  });

  it('a failing sink never breaks the session', () => {
    const send = (): void => {
      throw new Error('offline');
    };
    const reporter = new MetricsReporter({ sink: { send }, enabled: true, common });
    expect(() => reporter.transferEnded(finished('a'), CONTEXT)).not.toThrow();
  });
});
