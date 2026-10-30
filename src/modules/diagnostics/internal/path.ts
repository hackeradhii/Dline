import { ipFamily, isLocalAddress, sameIpv6Subnet, type CandidateType, type IpFamily } from '../../../shared/net';

export interface CandidateInfo {
  type: CandidateType;
  address: string | undefined;
  protocol: string;
  relayProtocol: string | undefined;
}

export type PathKind = 'lan' | 'internet' | 'relay';

export interface PathInfo {
  kind: PathKind;
  family: IpFamily;
  /** True when traffic goes through a TURN relay, i.e. NOT peer-to-peer. */
  relayed: boolean;
  local: CandidateInfo;
  remote: CandidateInfo;
}

/** A side counts as "on the LAN" when its address is private, or hidden behind mDNS on a host candidate. */
function onLan(c: CandidateInfo): boolean {
  return c.address ? isLocalAddress(c.address) : c.type === 'host';
}

/** The single path classifier used by the status chip, diagnostics panel and no-P2P screen (DRY). */
export function classifyPath(local: CandidateInfo, remote: CandidateInfo): PathInfo {
  const relayed = local.type === 'relay' || remote.type === 'relay';
  const sameNetwork = (onLan(local) && onLan(remote)) || sameIpv6Subnet(local.address, remote.address);
  const kind: PathKind = relayed ? 'relay' : sameNetwork ? 'lan' : 'internet';
  const localFamily = ipFamily(local.address);
  const family = localFamily === 'IPv4' || localFamily === 'IPv6' ? localFamily : ipFamily(remote.address);
  return { kind, family, relayed, local, remote };
}

export const PATH_LABEL: Record<PathKind, string> = {
  lan: 'Direct on the same network',
  internet: 'Direct over the internet',
  relay: 'Relayed, not peer-to-peer',
};

export function describePath(path: PathInfo): string {
  const family = path.family === 'IPv4' || path.family === 'IPv6' ? ` (${path.family})` : '';
  return path.kind === 'relay' ? PATH_LABEL.relay : `${PATH_LABEL[path.kind]}${family}`;
}
