import { describe, expect, it } from 'vitest';
import { bytesToIpv6, candidatesInSdp, ipv6ToBytes } from '../../../shared/net';
import { AUDIO_VIDEO_OFFER, CHROME_OFFER, FIREFOX_ANSWER } from './fixtures.test-data';
import { decodeLink, encodeLink, LinkError, newSessionId, parseFragment } from './link-codec';
import { extractCompact } from './sdp-codec';

const essentials = (sdp: string) => {
  const c = extractCompact(sdp, sdp.includes('setup:actpass') ? 'offer' : 'answer')!;
  return { ufrag: c.ufrag, pwd: c.pwd, fp: [...c.fingerprint], setup: c.setup, sctp: c.sctpPort, max: c.maxMessageSize };
};
const endpoints = (sdp: string) =>
  candidatesInSdp(sdp)
    .filter((c) => c.transport === 'udp')
    .map((c) => `${c.type} ${c.address} ${c.port} ${c.priority}`);

describe('link codec', () => {
  it.each([
    ['Chrome offer', 'o', CHROME_OFFER],
    ['Firefox answer', 'a', FIREFOX_ANSWER],
  ] as const)('round-trips a %s compactly, keeping everything ICE/DTLS needs', async (_, kind, sdp) => {
    const session = newSessionId();
    const fragment = await encodeLink({ kind, session, description: { type: kind === 'o' ? 'offer' : 'answer', sdp } });

    expect(fragment.startsWith(`${kind}.c`)).toBe(true);
    expect(fragment.length).toBeLessThan(260);

    const parsed = parseFragment(`#${fragment}`);
    if (!parsed || parsed.kind === 'room') throw new Error('expected a link fragment');
    const decoded = await decodeLink(parsed.kind, parsed.text);
    expect(decoded.session).toBe(session);
    expect(essentials(decoded.description.sdp!)).toEqual(essentials(sdp));
    expect(endpoints(decoded.description.sdp!)).toEqual(endpoints(sdp));
  });

  it('drops TCP candidates (never useful for browser-to-browser)', async () => {
    const fragment = await encodeLink({ kind: 'o', session: newSessionId(), description: { type: 'offer', sdp: CHROME_OFFER } });
    const decoded = await decodeLink('o', fragment.slice(2));
    expect(candidatesInSdp(decoded.description.sdp!).some((c) => c.transport === 'tcp')).toBe(false);
  });

  it('falls back to deflated full SDP for anything that is not data-channel-only', async () => {
    const fragment = await encodeLink({ kind: 'o', session: 'deadbeef', description: { type: 'offer', sdp: AUDIO_VIDEO_OFFER } });
    expect(fragment.startsWith('o.z')).toBe(true);
    const decoded = await decodeLink('o', fragment.slice(2));
    expect(decoded).toEqual({ kind: 'o', session: 'deadbeef', description: { type: 'offer', sdp: AUDIO_VIDEO_OFFER } });
  });

  it('rejects a reply pasted where an invite is expected, and garbage', async () => {
    const reply = await encodeLink({ kind: 'a', session: newSessionId(), description: { type: 'answer', sdp: FIREFOX_ANSWER } });
    await expect(decodeLink('o', reply.slice(2))).rejects.toMatchObject({ reason: 'kind' });
    await expect(decodeLink('o', 'c%%%')).rejects.toBeInstanceOf(LinkError);
    await expect(decodeLink('o', 'cAAAA')).rejects.toMatchObject({ reason: 'version' });
    await expect(decodeLink('o', 'xAAAA')).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('classifies fragments', () => {
    expect(parseFragment('#r.k7m-q2p')).toBeNull(); // contains lookalike-free letters only; "2" isn't in the alphabet
    expect(parseFragment('#r.K7MQ3P')).toEqual({ kind: 'room', code: 'K7MQ3P' });
    expect(parseFragment('#o.cABC')).toEqual({ kind: 'o', text: 'cABC' });
    expect(parseFragment('#hello')).toBeNull();
    expect(parseFragment('')).toBeNull();
  });
});

describe('IPv6 packing', () => {
  it.each(['2401:4900:1c2a:5d6e::1f', '::1', 'fe80::1', '2001:db8::', '1:2:3:4:5:6:7:8'])('round-trips %s', (address) => {
    expect(bytesToIpv6(ipv6ToBytes(address)!)).toBe(address);
  });

  it('handles embedded IPv4 and rejects junk', () => {
    expect(bytesToIpv6(ipv6ToBytes('::ffff:1.2.3.4')!)).toBe('::ffff:102:304');
    expect(ipv6ToBytes('1::2::3')).toBeNull();
    expect(ipv6ToBytes('12345::')).toBeNull();
  });
});
