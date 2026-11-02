import * as v from 'valibot';
import { normalizeRoomCode } from '../../../contracts/room';
import { fromBase64Url, fromHex, toBase64Url, toHex } from '../../../shared/bytes';
import { LINK } from '../../../shared/config';
import { BinaryReader, BinaryWriter } from './binary';
import { buildSdp, extractCompact, readCompact, writeCompact, type SdpType } from './sdp-codec';

/**
 * Invite/reply links carry the handshake in the URL fragment (never sent to any server):
 *   #o.<payload>  invite (offer)      #a.<payload>  reply (answer)      #r.<CODE>  room code
 * Payload formats: c = compact binary (preferred), z = deflated JSON SDP, p = plain JSON SDP.
 */

export type LinkKind = 'o' | 'a';

interface LinkPayload {
  kind: LinkKind;
  /** Random per-invite ID; a reply must carry the same one. */
  session: string;
  description: RTCSessionDescriptionInit;
}

/** malformed/version/kind: the link itself is bad. session: reply belongs to another invite. used: already paired. */
export type LinkErrorReason = 'malformed' | 'version' | 'kind' | 'session' | 'used';

export class LinkError extends Error {
  constructor(readonly reason: LinkErrorReason) {
    super(`Invalid link (${reason})`);
    this.name = 'LinkError';
  }
}

/** Why a link could not be used: a LinkError's reason, anything else counts as damaged. */
export function linkErrorReason(error: unknown): LinkErrorReason {
  return error instanceof LinkError ? error.reason : 'malformed';
}

type Fragment = { kind: 'room'; code: string } | { kind: LinkKind; text: string } | null;

const SDP_TYPE: Record<LinkKind, SdpType> = { o: 'offer', a: 'answer' };
const FullSchema = v.object({ v: v.number(), s: v.pipe(v.string(), v.regex(/^[0-9a-f]{8}$/)), sdp: v.string() });

/** Classifies a location hash without decoding it. */
export function parseFragment(hash: string): Fragment {
  const text = hash.replace(/^#/, '');
  const [prefix, rest] = [text.slice(0, 2), text.slice(2)];
  if (prefix === 'r.') {
    const code = normalizeRoomCode(rest);
    return code ? { kind: 'room', code } : null;
  }
  if ((prefix === 'o.' || prefix === 'a.') && rest.length > 1) return { kind: prefix[0] as LinkKind, text: rest };
  return null;
}

export async function encodeLink(payload: LinkPayload): Promise<string> {
  const sdp = payload.description.sdp ?? '';
  const compact = extractCompact(sdp, SDP_TYPE[payload.kind]);
  if (compact) {
    const w = new BinaryWriter().u8(LINK.version).bytes(fromHex(payload.session));
    writeCompact(w, compact);
    return `${payload.kind}.c${toBase64Url(w.toBytes())}`;
  }
  const json = new TextEncoder().encode(JSON.stringify({ v: LINK.version, s: payload.session, sdp }));
  const deflated = await deflate(json);
  return deflated ? `${payload.kind}.z${toBase64Url(deflated)}` : `${payload.kind}.p${toBase64Url(json)}`;
}

/** Decodes the body of a link fragment of the given kind. Throws LinkError. */
export async function decodeLink(kind: LinkKind, text: string): Promise<LinkPayload> {
  const format = text[0];
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text.slice(1));
  } catch {
    throw new LinkError('malformed');
  }
  if (format === 'c') return decodeCompact(kind, bytes);
  if (format === 'z' || format === 'p') return decodeFull(kind, format === 'z' ? await inflate(bytes) : bytes);
  throw new LinkError('malformed');
}

export function newSessionId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(LINK.sessionIdBytes)));
}

function decodeCompact(kind: LinkKind, bytes: Uint8Array): LinkPayload {
  const r = new BinaryReader(bytes);
  try {
    if (r.u8() !== LINK.version) throw new LinkError('version');
    const session = toHex(r.bytes(LINK.sessionIdBytes));
    const compact = readCompact(r);
    if (compact.type !== SDP_TYPE[kind]) throw new LinkError('kind');
    return { kind, session, description: { type: compact.type, sdp: buildSdp(compact) } };
  } catch (error) {
    throw error instanceof LinkError ? error : new LinkError('malformed');
  }
}

function decodeFull(kind: LinkKind, bytes: Uint8Array | null): LinkPayload {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
  } catch {
    throw new LinkError('malformed');
  }
  const parsed = v.safeParse(FullSchema, data);
  if (!parsed.success) throw new LinkError('malformed');
  if (parsed.output.v !== LINK.version) throw new LinkError('version');
  return { kind, session: parsed.output.s, description: { type: SDP_TYPE[kind], sdp: parsed.output.sdp } };
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function') return null;
  return pipeThrough(bytes, new CompressionStream('deflate-raw'));
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream !== 'function') return null;
  try {
    return await pipeThrough(bytes, new DecompressionStream('deflate-raw'));
  } catch {
    return null;
  }
}

async function pipeThrough(bytes: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
