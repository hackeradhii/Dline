/** Public API of the diagnostics module: live path/stats, pre-flight check, no-P2P diagnosis, safety code. */
import { candidatesInSdp, parseCandidate, type ParsedCandidate } from '../../shared/net';
import { analyzeCandidates, type NetworkProfile } from './internal/network-analysis';

export { StatsMonitor, type ConnectionSnapshot } from './internal/stats-monitor';
export { describeCandidate, describePath, type PathInfo } from './internal/path';
export { probeNetwork } from './internal/preflight';
export { diagnoseNoPath, type NetworkProfile, type NoPathCause, type Verdict } from './internal/network-analysis';
export { safetyCode } from './internal/safety-code';

/** Profiles the other side's network from the candidates it sent us (SDP + trickled). */
export function remoteProfile(descriptions: { remote: string; remoteCandidates: readonly string[] }): NetworkProfile | null {
  const trickled = descriptions.remoteCandidates.map(parseCandidate).filter((c): c is ParsedCandidate => c !== null);
  const all = [...candidatesInSdp(descriptions.remote), ...trickled];
  return all.length ? analyzeCandidates(all) : null;
}
