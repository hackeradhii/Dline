import { describe, expect, it } from 'vitest';
import { STATS } from '../../../shared/config';
import { parseCandidate, type ParsedCandidate } from '../../../shared/net';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { analyzeCandidates, diagnoseNoPath } from './network-analysis';
import { classifyPath, describePath } from './path';
import { safetyCode } from './safety-code';
import { StatsMonitor, type ConnectionSnapshot } from './stats-monitor';
import { parseStats } from './stats-parser';
import { WORDS } from './wordlist';

const cands = (...lines: string[]): ParsedCandidate[] => lines.map((l) => parseCandidate(l)!);
const HOST = 'candidate:1 1 udp 2122260223 4d6b7f3e-12ab-4cde-9f01-23456789abcd.local 50000 typ host';

describe('network analysis (pre-flight + remote profile)', () => {
  it('rates a cone NAT with IPv6 as good', () => {
    const p = analyzeCandidates(
      cands(HOST, 'candidate:2 1 udp 1686052607 203.0.113.7 50000 typ srflx raddr 0.0.0.0 rport 0', 'candidate:3 1 udp 1686052863 2401:4900::1f 50001 typ srflx raddr :: rport 0'),
    );
    expect(p).toMatchObject({ udp: true, ipv4: 'cone', ipv6: true, verdict: 'good' });
  });

  it('detects symmetric NAT from two STUN mappings with different ports', () => {
    const p = analyzeCandidates(
      cands(HOST, 'candidate:2 1 udp 1686052607 203.0.113.7 40001 typ srflx raddr 0.0.0.0 rport 0', 'candidate:3 1 udp 1686052607 203.0.113.7 40777 typ srflx raddr 0.0.0.0 rport 0'),
    );
    expect(p).toMatchObject({ ipv4: 'symmetric', ipv6: false, verdict: 'risky' });
  });

  it('calls a network with only local candidates blocked', () => {
    expect(analyzeCandidates(cands(HOST)).verdict).toBe('blocked');
  });

  it('flags relay-only browsers', () => {
    expect(analyzeCandidates(cands('candidate:9 1 udp 41885439 198.51.100.1 3478 typ relay raddr 0.0.0.0 rport 0')).relayOnly).toBe(true);
  });

  it('diagnoses the no-path cause', () => {
    const blocked = analyzeCandidates(cands(HOST));
    const strict = analyzeCandidates(
      cands('candidate:2 1 udp 1 203.0.113.7 40001 typ srflx raddr 0.0.0.0 rport 0', 'candidate:3 1 udp 1 203.0.113.7 40777 typ srflx raddr 0.0.0.0 rport 0'),
    );
    const v6only = analyzeCandidates(cands('candidate:3 1 udp 1 2401:4900::1f 50001 typ srflx raddr :: rport 0'));
    expect(diagnoseNoPath(blocked, strict)).toEqual(['local-blocked']);
    expect(diagnoseNoPath(strict, strict)).toEqual(['both-strict-nat']);
    expect(diagnoseNoPath(strict, v6only)).toEqual(['family-mismatch']);
    expect(diagnoseNoPath(null, null)).toEqual(['unknown']);
  });
});

describe('path classification', () => {
  const c = (type: 'host' | 'srflx' | 'prflx' | 'relay', address?: string) => ({ type, address, protocol: 'udp', relayProtocol: undefined });

  it.each([
    [c('host', '192.168.1.4'), c('host', undefined), 'Direct on the same network (IPv4)'],
    [c('srflx', '203.0.113.7'), c('prflx', '198.51.100.9'), 'Direct over the internet (IPv4)'],
    [c('host', '2401:4900::1f'), c('host', '2405:201::9'), 'Direct over the internet (IPv6)'],
    [c('host', '2401:4900:8fdc:63a2::1'), c('prflx', '2401:4900:8fdc:63a2::9'), 'Direct on the same network (IPv6)'],
    [c('relay', '198.51.100.1'), c('srflx', '203.0.113.7'), 'Relayed, not peer-to-peer'],
  ])('%o ↔ %o → %s', (local, remote, label) => {
    expect(describePath(classifyPath(local, remote))).toBe(label);
  });
});

describe('stats parsing', () => {
  it('finds the selected pair via the transport and reads RTT, bitrate and video', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
      ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.042, availableOutgoingBitrate: 5e6, bytesSent: 10, bytesReceived: 20, timestamp: 1000 }],
      ['L', { id: 'L', type: 'local-candidate', candidateType: 'srflx', address: '203.0.113.7', protocol: 'udp' }],
      ['R', { id: 'R', type: 'remote-candidate', candidateType: 'host', address: '2405:201::9', protocol: 'udp' }],
      ['V', { id: 'V', type: 'inbound-rtp', kind: 'video', frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, codecId: 'C', packetsLost: 1, packetsReceived: 99 }],
      ['C', { id: 'C', type: 'codec', mimeType: 'video/VP8' }],
    ]);
    const s = parseStats(report as unknown as RTCStatsReport);
    expect(s.rttMs).toBeCloseTo(42);
    expect(s.availableOutgoingBps).toBe(5e6);
    expect(s.path?.kind).toBe('internet');
    expect(s.inboundVideo).toEqual({ width: 1280, height: 720, fps: 30, codec: 'VP8', limitedBy: null });
  });

  it('falls back to Firefox-style selected pairs', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['P', { id: 'P', type: 'candidate-pair', selected: true, localCandidateId: 'L', remoteCandidateId: 'R' }],
      ['L', { id: 'L', type: 'local-candidate', candidateType: 'relay', address: '198.51.100.1' }],
      ['R', { id: 'R', type: 'remote-candidate', candidateType: 'srflx', address: '203.0.113.7' }],
    ]);
    expect(parseStats(report as unknown as RTCStatsReport).path?.relayed).toBe(true);
  });

  it('adds up what the call sends, audio and video, and names the selected pair', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
      ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' }],
      ['A', { id: 'A', type: 'outbound-rtp', kind: 'audio', bytesSent: 4_000 }],
      ['V', { id: 'V', type: 'outbound-rtp', kind: 'video', bytesSent: 96_000 }],
      ['I', { id: 'I', type: 'inbound-rtp', kind: 'video', bytesReceived: 50_000 }],
    ]);
    expect(parseStats(report as unknown as RTCStatsReport)).toMatchObject({ pairId: 'P', mediaBytesSent: 100_000 });
    expect(parseStats(new Map() as unknown as RTCStatsReport)).toMatchObject({ pairId: null, mediaBytesSent: 0 });
  });
});

describe('stats monitor', () => {
  it('turns what the call sent into bits per second', async () => {
    const report = (at: number, bytesSent: number) =>
      new Map<string, Record<string, unknown>>([
        ['P', { id: 'P', type: 'candidate-pair', selected: true, timestamp: at }],
        ['V', { id: 'V', type: 'outbound-rtp', kind: 'video', bytesSent }],
      ]) as unknown as RTCStatsReport;
    const reports = [report(1_000, 50_000), report(2_000, 362_500)];
    const clock = new FakeClock();
    const monitor = new StatsMonitor({ getStats: async () => reports.shift()! }, clock);
    const snapshots: ConnectionSnapshot[] = [];
    monitor.events.on('snapshot', (s) => snapshots.push(s));
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    monitor.start();
    await settle();
    clock.advance(STATS.intervalMs);
    await settle();
    monitor.stop();
    expect(snapshots.map((s) => s.mediaSendBps)).toEqual([0, 2_500_000]);
  });
});

describe('safety code', () => {
  const sdp = (hex: string) => `v=0\r\na=fingerprint:sha-256 ${hex}\r\n`;
  const A = sdp('AA:'.repeat(31) + 'AA');
  const B = sdp('BB:'.repeat(31) + 'BB');

  it('is the same on both sides and changes if a fingerprint changes', async () => {
    const mine = await safetyCode(A, B);
    expect(mine).toHaveLength(4);
    expect(await safetyCode(B, A)).toEqual(mine);
    expect(await safetyCode(A, sdp('CC:'.repeat(31) + 'CC'))).not.toEqual(mine);
  });

  it('has 256 unique words', () => {
    expect(new Set(WORDS).size).toBe(256);
  });
});
