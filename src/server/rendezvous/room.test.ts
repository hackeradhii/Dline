import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Inbound } from '../../contracts/signaling';

const ORIGIN = 'https://dline.test';

/** Opens a socket to the Worker and collects parsed messages. */
async function connect(code: string, query = '') {
  const res = await exports.default.fetch(`${ORIGIN}/ws/${code}${query}`, {
    headers: { Upgrade: 'websocket', Origin: ORIGIN },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const inbox: Inbound[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener('message', (e) => {
    inbox.push(JSON.parse(e.data as string) as Inbound);
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (): Promise<Inbound> => {
    while (inbox.length === 0) await new Promise<void>((r) => waiters.push(r));
    return inbox.shift()!;
  };
  return { ws, next };
}

describe('rendezvous room', () => {
  it('assigns host and guest, then relays signals both ways', async () => {
    const host = await connect('ABCDEF', '?create');
    expect(await host.next()).toMatchObject({ t: 'joined', role: 'host', peer: false });

    const guest = await connect('ABCDEF');
    expect(await guest.next()).toMatchObject({ t: 'joined', role: 'guest', peer: true });
    expect(await host.next()).toEqual({ t: 'peer', present: true });

    host.ws.send(JSON.stringify({ t: 'sdp', d: { type: 'offer', sdp: 'v=0' } }));
    expect(await guest.next()).toEqual({ t: 'sdp', d: { type: 'offer', sdp: 'v=0' } });

    guest.ws.send(JSON.stringify({ t: 'ice', c: null }));
    expect(await host.next()).toEqual({ t: 'ice', c: null });
  });

  it('rejects a third peer and unknown rooms', async () => {
    await connect('BCDEFG', '?create');
    await connect('BCDEFG');
    const third = await connect('BCDEFG');
    expect(await third.next()).toEqual({ t: 'error', code: 'room-full' });

    const stranger = await connect('CDEFGH');
    expect(await stranger.next()).toEqual({ t: 'error', code: 'no-room' });
  });

  it('rejects malformed signals without relaying them', async () => {
    const host = await connect('DEFGHJ', '?create');
    await host.next();
    host.ws.send(JSON.stringify({ t: 'evil', payload: 1 }));
    expect(await host.next()).toEqual({ t: 'error', code: 'bad-request' });
  });

  it('lets a peer rejoin with its token (network switch) and replaces the old socket', async () => {
    const host = await connect('EFGHJK', '?create');
    const joined = await host.next();
    if (joined.t !== 'joined') throw new Error('expected joined');

    const again = await connect('EFGHJK', `?token=${joined.token}`);
    expect(await again.next()).toMatchObject({ t: 'joined', role: 'host' });
    expect(await host.next()).toEqual({ t: 'error', code: 'replaced' });

    const forged = await connect('EFGHJK', '?token=not-a-real-token');
    expect(await forged.next()).toEqual({ t: 'error', code: 'expired' });
  });

  it('refuses cross-origin sockets and bad codes', async () => {
    const cross = await exports.default.fetch(`${ORIGIN}/ws/FGHJKM`, { headers: { Upgrade: 'websocket', Origin: 'https://evil.test' } });
    expect(cross.status).toBe(403);
    const bad = await exports.default.fetch(`${ORIGIN}/ws/nope`, { headers: { Upgrade: 'websocket', Origin: ORIGIN } });
    expect(bad.status).toBe(400);
  });
});
