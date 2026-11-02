import type { CandidateType } from '../../../shared/net';
import { classifyPath, type CandidateInfo, type PathInfo } from './path';

interface VideoInfo {
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  /** Why the sender lowered quality: 'bandwidth', 'cpu', 'none' or 'other' (outbound only). */
  limitedBy: string | null;
}

/** One raw reading of `getStats()`, reduced to what the UI and pacing need. */
export interface StatsSample {
  timestamp: number;
  path: PathInfo | null;
  /** Opaque id of the selected candidate pair: it changes when the path does. */
  pairId: string | null;
  rttMs: number | null;
  availableOutgoingBps: number | null;
  bytesSent: number;
  bytesReceived: number;
  /** Audio and video bytes sent so far (outbound RTP). */
  mediaBytesSent: number;
  packetsLost: number;
  packetsReceived: number;
  inboundVideo: VideoInfo | null;
  outboundVideo: VideoInfo | null;
}

type Stat = Record<string, unknown> & { type: string; id: string };

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function selectedPair(stats: Stat[], byId: Map<string, Stat>): Stat | undefined {
  for (const s of stats) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      const pair = byId.get(s.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  // Firefox marks the pair itself; older engines only expose nominated + succeeded.
  return (
    stats.find((s) => s.type === 'candidate-pair' && s.selected === true) ??
    stats.find((s) => s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded')
  );
}

function candidate(stat: Stat | undefined): CandidateInfo | null {
  if (!stat) return null;
  return {
    type: (str(stat.candidateType) ?? 'host') as CandidateType,
    address: str(stat.address) ?? str(stat.ip),
    protocol: str(stat.protocol) ?? 'udp',
    relayProtocol: str(stat.relayProtocol),
  };
}

function video(stat: Stat | undefined, byId: Map<string, Stat>): VideoInfo | null {
  if (!stat) return null;
  const codec = typeof stat.codecId === 'string' ? str(byId.get(stat.codecId)?.mimeType) : undefined;
  return {
    width: num(stat.frameWidth),
    height: num(stat.frameHeight),
    fps: num(stat.framesPerSecond),
    codec: codec?.replace(/^video\//, '') ?? null,
    limitedBy: str(stat.qualityLimitationReason) ?? null,
  };
}

export function parseStats(report: RTCStatsReport): StatsSample {
  const stats = [...(report as unknown as Map<string, Stat>).values()];
  const byId = new Map(stats.map((s) => [s.id, s]));
  const pair = selectedPair(stats, byId);
  const local = candidate(pair && byId.get(String(pair.localCandidateId)));
  const remote = candidate(pair && byId.get(String(pair.remoteCandidateId)));
  const inbound = stats.filter((s) => s.type === 'inbound-rtp');
  const rtt = num(pair?.currentRoundTripTime);
  const outgoing = num(pair?.availableOutgoingBitrate);

  return {
    timestamp: num(pair?.timestamp) ?? Date.now(),
    path: local && remote ? classifyPath(local, remote) : null,
    pairId: pair?.id ?? null,
    rttMs: rtt === null ? null : rtt * 1000,
    availableOutgoingBps: outgoing,
    bytesSent: num(pair?.bytesSent) ?? 0,
    bytesReceived: num(pair?.bytesReceived) ?? 0,
    mediaBytesSent: stats.filter((s) => s.type === 'outbound-rtp').reduce((sum, s) => sum + (num(s.bytesSent) ?? 0), 0),
    packetsLost: inbound.reduce((sum, s) => sum + (num(s.packetsLost) ?? 0), 0),
    packetsReceived: inbound.reduce((sum, s) => sum + (num(s.packetsReceived) ?? 0), 0),
    inboundVideo: video(inbound.find((s) => s.kind === 'video'), byId),
    outboundVideo: video(stats.find((s) => s.type === 'outbound-rtp' && s.kind === 'video'), byId),
  };
}
