import { fromHex, toHex } from '../../../shared/bytes';
import { formatCandidate, parseCandidate, type CandidateType, type ParsedCandidate } from '../../../shared/net';
import { sdpAttribute, sdpFingerprint } from '../../../shared/sdp';
import { ADDRESS_BYTES, AddressKind, packAddress, unpackAddress } from './address-codec';
import type { BinaryReader, BinaryWriter } from './binary';

/**
 * Compact codec for a data-channel-only SDP. Only the fields ICE and DTLS actually need survive:
 * ICE credentials, the DTLS fingerprint and role, SCTP parameters and UDP candidates. The other side
 * rebuilds a standard SDP from them. ~150–250 base64url characters instead of ~900.
 */

export type SdpType = 'offer' | 'answer';
type Setup = 'actpass' | 'active' | 'passive';

interface CompactDescription {
  type: SdpType;
  ufrag: string;
  pwd: string;
  fingerprint: Uint8Array;
  setup: Setup;
  mid: string;
  sctpPort: number;
  maxMessageSize: number;
  candidates: ParsedCandidate[];
}

const SETUPS: readonly Setup[] = ['actpass', 'active', 'passive'];
const TYPES: readonly CandidateType[] = ['host', 'srflx', 'prflx', 'relay'];
const FINGERPRINT_BYTES = 32;

/** Returns null when the SDP isn't a single data-channel section we can compact (caller falls back). */
export function extractCompact(sdp: string, type: SdpType): CompactDescription | null {
  const lines = sdp.split(/\r?\n/);
  const media = lines.filter((l) => l.startsWith('m='));
  if (media.length !== 1 || !media[0]!.startsWith('m=application') || !media[0]!.includes('webrtc-datachannel')) return null;

  const attr = (name: string): string | undefined => sdpAttribute(sdp, name);
  const fp = sdpFingerprint(sdp);
  const setup = attr('setup') as Setup | undefined;
  const ufrag = attr('ice-ufrag');
  const pwd = attr('ice-pwd');
  if (fp?.algorithm !== 'sha-256' || !ufrag || !pwd || !setup || !SETUPS.includes(setup)) return null;

  const fingerprint = fromHex(fp.hex);
  if (fingerprint.length !== FINGERPRINT_BYTES) return null;
  const candidates = lines
    .filter((l) => l.startsWith('a=candidate:'))
    .map(parseCandidate)
    .filter((c): c is ParsedCandidate => c !== null && c.transport === 'udp' && c.component === 1);

  return {
    type,
    ufrag,
    pwd,
    fingerprint,
    setup,
    mid: attr('mid') ?? '0',
    sctpPort: Number(attr('sctp-port') ?? 5000),
    maxMessageSize: Number(attr('max-message-size') ?? 0),
    candidates,
  };
}

export function buildSdp(d: CompactDescription): string {
  const fingerprint = toHex(d.fingerprint, ':').toUpperCase();
  const sessionId = Math.floor(Math.random() * 2 ** 52);
  const lines = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${d.mid}`,
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${d.ufrag}`,
    `a=ice-pwd:${d.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${d.setup}`,
    `a=mid:${d.mid}`,
    `a=sctp-port:${d.sctpPort}`,
    ...(d.maxMessageSize > 0 ? [`a=max-message-size:${d.maxMessageSize}`] : []),
    ...d.candidates.map((c, i) => `a=${formatCandidate({ ...c, foundation: String(i + 1) })}`),
    'a=end-of-candidates',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Binary layout (all big-endian): see README "Link format". */
export function writeCompact(w: BinaryWriter, d: CompactDescription): void {
  w.u8((d.type === 'answer' ? 1 : 0) | (SETUPS.indexOf(d.setup) << 1));
  w.bytes(d.fingerprint).str(d.ufrag).str(d.pwd).str(d.mid).u16(d.sctpPort).u32(d.maxMessageSize);
  const candidates = d.candidates.slice(0, 255);
  w.u8(candidates.length);
  for (const c of candidates) {
    const packed = packAddress(c.address);
    w.u8(TYPES.indexOf(c.type) | (packed.kind << 2)).u32(c.priority).u16(c.port);
    if ('text' in packed) w.str(packed.text);
    else w.bytes(packed.bytes);
  }
}

export function readCompact(r: BinaryReader): CompactDescription {
  const flags = r.u8();
  const setup = SETUPS[(flags >> 1) & 0b11];
  if (!setup) throw new Error('Bad setup role');
  const fingerprint = r.bytes(FINGERPRINT_BYTES);
  const ufrag = r.str();
  const pwd = r.str();
  const mid = r.str();
  const sctpPort = r.u16();
  const maxMessageSize = r.u32();
  const count = r.u8();
  const candidates: ParsedCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const head = r.u8();
    const type = TYPES[head & 0b11]!;
    const kind = ((head >> 2) & 0b11) as AddressKind;
    const priority = r.u32();
    const port = r.u16();
    const address = kind === AddressKind.Text ? r.str() : unpackAddress(kind, r.bytes(ADDRESS_BYTES[kind]));
    candidates.push({ foundation: String(i + 1), component: 1, transport: 'udp', priority, address, port, type });
  }
  return { type: flags & 1 ? 'answer' : 'offer', ufrag, pwd, fingerprint, setup, mid, sctpPort, maxMessageSize, candidates };
}
