/**
 * ICE candidate parsing and address classification.
 * One implementation used by the link codec, pre-flight probe, path badge and no-P2P diagnosis (DRY).
 */

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export type IpFamily = 'IPv4' | 'IPv6' | 'mdns' | 'unknown';
type Transport = 'udp' | 'tcp';

export interface ParsedCandidate {
  foundation: string;
  component: number;
  transport: Transport;
  priority: number;
  address: string;
  port: number;
  type: CandidateType;
  relatedAddress?: string;
  relatedPort?: number;
}

const CANDIDATE_TYPES: readonly string[] = ['host', 'srflx', 'prflx', 'relay'];

/** Parses `candidate:...` or `a=candidate:...`. Returns null for anything malformed. */
export function parseCandidate(line: string): ParsedCandidate | null {
  const text = line.trim().replace(/^a=/, '').replace(/^candidate:/, '');
  const parts = text.split(/\s+/);
  if (parts.length < 8 || parts[6] !== 'typ') return null;
  const [foundation, component, transport, priority, address, port, , type] = parts as [
    string, string, string, string, string, string, string, string,
  ];
  const t = transport.toLowerCase();
  if ((t !== 'udp' && t !== 'tcp') || !CANDIDATE_TYPES.includes(type)) return null;
  const candidate: ParsedCandidate = {
    foundation,
    component: Number(component),
    transport: t,
    priority: Number(priority),
    address,
    port: Number(port),
    type: type as CandidateType,
  };
  for (let i = 8; i + 1 < parts.length; i += 2) {
    if (parts[i] === 'raddr') candidate.relatedAddress = parts[i + 1];
    if (parts[i] === 'rport') candidate.relatedPort = Number(parts[i + 1]);
  }
  if (!Number.isFinite(candidate.priority) || !Number.isInteger(candidate.port)) return null;
  return candidate;
}

export function formatCandidate(c: ParsedCandidate): string {
  let line = `candidate:${c.foundation} ${c.component} ${c.transport} ${c.priority} ${c.address} ${c.port} typ ${c.type}`;
  if (c.type !== 'host') line += ` raddr ${c.relatedAddress ?? '0.0.0.0'} rport ${c.relatedPort ?? 0}`;
  return line;
}

/** All candidates found in an SDP blob. */
export function candidatesInSdp(sdp: string): ParsedCandidate[] {
  return sdp
    .split(/\r?\n/)
    .filter((l) => l.startsWith('a=candidate:'))
    .map(parseCandidate)
    .filter((c): c is ParsedCandidate => c !== null);
}

export function ipFamily(address: string | undefined): IpFamily {
  if (!address) return 'unknown';
  if (address.endsWith('.local')) return 'mdns';
  if (address.includes(':')) return 'IPv6';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return 'IPv4';
  return 'unknown';
}

/** True for addresses only reachable on the local network (RFC 1918, link-local, ULA, loopback, mDNS). */
export function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  const family = ipFamily(address);
  if (family === 'mdns') return true;
  if (family === 'IPv4') {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (family === 'IPv6') {
    const head = address.toLowerCase();
    return head === '::1' || head.startsWith('fe80') || head.startsWith('fc') || head.startsWith('fd');
  }
  return false;
}

/** A global (internet-routable) IPv6 address, the usual direct path on Indian mobile networks. */
export function isGlobalIpv6(address: string | undefined): boolean {
  return ipFamily(address) === 'IPv6' && !isLocalAddress(address);
}

export function ipv6ToBytes(address: string): Uint8Array | null {
  const plain = address.split('%')[0]!.toLowerCase();
  const halves = plain.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string | undefined): string[] => (part ? part.split(':') : []);
  const expandV4 = (groups: string[]): string[] | null => {
    const last = groups[groups.length - 1];
    if (!last?.includes('.')) return groups;
    const octets = last.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !(o >= 0 && o <= 255))) return null;
    return [...groups.slice(0, -1), ((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16)];
  };
  const head = expandV4(groupsOf(halves[0]));
  const tail = halves.length === 2 ? expandV4(groupsOf(halves[1])) : [];
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 2 && fill < 1) || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const value = parseInt(g, 16);
    out[i * 2] = value >> 8;
    out[i * 2 + 1] = value & 0xff;
  }
  return out;
}

/** RFC 5952 canonical text form (lowercase, longest zero run compressed). */
export function bytesToIpv6(bytes: Uint8Array): string {
  const groups = Array.from({ length: 8 }, (_, i) => ((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!).toString(16));
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  if (bestStart < 0) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
}

/** Both global IPv6 addresses are in the same /64, i.e. on the same LAN segment. */
export function sameIpv6Subnet(a: string | undefined, b: string | undefined): boolean {
  if (ipFamily(a) !== 'IPv6' || ipFamily(b) !== 'IPv6') return false;
  const x = ipv6ToBytes(a!);
  const y = ipv6ToBytes(b!);
  return !!x && !!y && x.subarray(0, 8).every((byte, i) => byte === y[i]);
}
