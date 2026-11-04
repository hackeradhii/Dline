import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { METRICS_PATH, type MetricsEvent } from '../contracts/metrics';
import { describeMetrics, handleMetrics } from './metrics';

const ORIGIN = 'https://dline.test';
const URL = `${ORIGIN}${METRICS_PATH}`;
const common = { session: 'abcdefgh12', role: 'host', mode: 'rendezvous', device: 'Android Chrome 156' } as const;
const PATH = { kind: 'internet', family: 'IPv6', local: 'srflx', remote: 'prflx' } as const;
const TRANSFER: MetricsEvent = {
  t: 'transfer',
  ...common,
  direction: 'out',
  status: 'done',
  size: 74_700_000,
  bytes: 74_700_000,
  ms: 90_000,
  bps: 830_000,
  verified: true,
  lanes: 16,
  call: true,
  pacing: 'flow',
  path: PATH,
  rttMs: 60,
};

const post = (body: string, headers: Record<string, string> = { Origin: ORIGIN }) => new Request(URL, { method: 'POST', body, headers });

async function report(request: Request) {
  const lines: object[] = [];
  const response = await handleMetrics(request, env, (line) => lines.push(line));
  return { status: response.status, lines };
}

describe('performance reports', () => {
  it('logs a valid report as a readable line with its fields', async () => {
    const { status, lines } = await report(post(JSON.stringify(TRANSFER)));
    expect(status).toBe(204);
    expect(lines).toEqual([{ message: describeMetrics(TRANSFER), metrics: TRANSFER }]);
  });

  it('keeps the app build when a report names it, and still takes reports from older pages without one', async () => {
    const withBuild = { ...TRANSFER, build: '2026-11-04 10:45' };
    expect((await report(post(JSON.stringify(withBuild)))).lines).toEqual([{ message: describeMetrics(withBuild), metrics: withBuild }]);
    expect((await report(post(JSON.stringify(TRANSFER)))).status).toBe(204);
  });

  it('reaches the Worker at /api/metrics', async () => {
    const response = await exports.default.fetch(post(JSON.stringify(TRANSFER)));
    expect(response.status).toBe(204);
  });

  it('logs only validated fields: unknown ones are dropped', async () => {
    const { lines } = await report(post(JSON.stringify({ ...TRANSFER, name: 'holiday.mp4' })));
    expect(JSON.stringify(lines)).not.toContain('holiday');
  });

  it('refuses other sites, other methods, oversized and malformed reports, and logs nothing', async () => {
    const cases = [
      [post(JSON.stringify(TRANSFER), { Origin: 'https://evil.test' }), 403],
      [post(JSON.stringify(TRANSFER), {}), 403],
      [new Request(URL, { headers: { Origin: ORIGIN } }), 405],
      [post(JSON.stringify({ ...TRANSFER, device: 'x'.repeat(5000) })), 400],
      [post(JSON.stringify({ ...TRANSFER, bytes: -1 })), 400],
      [post('not json'), 400],
    ] as const;
    for (const [request, expected] of cases) {
      const { status, lines } = await report(request);
      expect(status).toBe(expected);
      expect(lines).toEqual([]);
    }
  });

  it('describes each report in one line', () => {
    expect(describeMetrics(TRANSFER)).toBe('transfer out done: 71.2 MB of 71.2 MB in 1m 30s at 811 KB/s · 16 lanes · internet IPv6 (srflx ↔ prflx) · ping 60 ms · call on · pacing flow');
    expect(
      describeMetrics({ t: 'connect', ...common, outcome: 'failed', ms: 12_000, causes: ['unknown'], local: { udp: true, ipv4: 'symmetric', ipv6: false, relayOnly: false } }),
    ).toBe('connect: FAILED after 12s · causes unknown · local udp yes, IPv4 symmetric, IPv6 no');
    const side = { bytes: 1024, files: 1, failed: 0, avgBps: 512, peakBps: 1024 };
    expect(describeMetrics({ t: 'session', ...common, end: 'left', ms: 65_000, up: side, down: { ...side, files: 2, failed: 1 }, callMs: 0, maxLanes: 1, recoveries: 1 })).toBe(
      'session: ended (left) after 1m 5s · up 1.00 KB in 1 file, avg 512 B/s, peak 1.00 KB/s · down 1.00 KB in 2 files (1 failed), avg 512 B/s, peak 1.00 KB/s · call none · 1 recovery · up to 1 lane',
    );
  });
});
