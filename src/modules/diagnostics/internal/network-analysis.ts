import { ipFamily, isGlobalIpv6, type ParsedCandidate } from '../../../shared/net';

/**
 * What a set of ICE candidates says about a network. Used for our own pre-flight check and,
 * from the other side's candidates, to explain why no direct path was found.
 */

/** none: no IPv4 public address learned; open: no NAT; cone: hole-punchable NAT; symmetric: strict NAT. */
export type Ipv4Nat = 'none' | 'open' | 'cone' | 'symmetric';
export type Verdict = 'good' | 'risky' | 'blocked';

export interface NetworkProfile {
  /** Any candidate that could reach beyond the LAN (UDP reachable to STUN, or global IPv6). */
  udp: boolean;
  ipv4: Ipv4Nat;
  ipv6: boolean;
  /** Only relay candidates: a browser privacy setting/extension is forcing TURN. */
  relayOnly: boolean;
  verdict: Verdict;
}

export function analyzeCandidates(candidates: readonly ParsedCandidate[]): NetworkProfile {
  const udp = candidates.filter((c) => c.transport === 'udp');
  const srflx = udp.filter((c) => c.type === 'srflx' || c.type === 'prflx');
  const relayOnly = udp.length > 0 && udp.every((c) => c.type === 'relay');

  const v4 = srflx.filter((c) => ipFamily(c.address) === 'IPv4');
  const portsByAddress = new Map<string, Set<number>>();
  for (const c of v4) portsByAddress.set(c.address, (portsByAddress.get(c.address) ?? new Set()).add(c.port));
  const hostAddresses = new Set(udp.filter((c) => c.type === 'host').map((c) => c.address));

  // Two STUN servers share one socket: a cone NAT maps it to one public port, a symmetric NAT to two.
  const ipv4: Ipv4Nat =
    v4.length === 0 ? 'none'
    : [...portsByAddress.values()].some((ports) => ports.size > 1) ? 'symmetric'
    : v4.some((c) => hostAddresses.has(c.address)) ? 'open'
    : 'cone';
  const ipv6 = udp.some((c) => c.type !== 'relay' && isGlobalIpv6(c.address));
  const reachable = srflx.length > 0 || ipv6;

  const verdict: Verdict = !reachable ? 'blocked' : ipv6 || ipv4 === 'open' || ipv4 === 'cone' ? 'good' : 'risky';
  return { udp: reachable, ipv4, ipv6, relayOnly, verdict };
}

export type NoPathCause =
  | 'local-blocked'
  | 'remote-blocked'
  | 'both-strict-nat'
  | 'family-mismatch'
  | 'relay-only-browser'
  | 'unknown';

/** Most likely reasons, best first, for "no direct path between these two networks". */
export function diagnoseNoPath(local: NetworkProfile | null, remote: NetworkProfile | null): NoPathCause[] {
  const causes: NoPathCause[] = [];
  if (local?.relayOnly || remote?.relayOnly) causes.push('relay-only-browser');
  if (local && !local.udp) causes.push('local-blocked');
  if (remote && !remote.udp) causes.push('remote-blocked');
  if (local && remote && local.udp && remote.udp) {
    const v4Common = local.ipv4 !== 'none' && remote.ipv4 !== 'none';
    const v6Common = local.ipv6 && remote.ipv6;
    if (!v4Common && !v6Common) causes.push('family-mismatch');
    else if (!v6Common && local.ipv4 === 'symmetric' && remote.ipv4 === 'symmetric') causes.push('both-strict-nat');
  }
  return causes.length ? causes : ['unknown'];
}
