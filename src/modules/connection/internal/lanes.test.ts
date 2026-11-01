import { describe, expect, it } from 'vitest';
import { LANES } from '../../../shared/config';
import { asChannel, fakeChannelFactories, fakeChannelPair } from '../../../shared/testing/fake-channels';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { fakePeerFactory, type FakePeer } from '../../../shared/testing/fake-peers';
import { DataControlChannel } from './control-channel';
import { extraLanesFor, LanePool } from './lanes';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const [ctrlA, ctrlB] = fakeChannelPair('ctrl');
  const control = { host: new DataControlChannel(), guest: new DataControlChannel() };
  control.host.attach(asChannel(ctrlA));
  control.guest.attach(asChannel(ctrlB));
  const main = fakeChannelFactories(64 * 1024);
  const peers = { host: fakePeerFactory(), guest: fakePeerFactory() };
  const clock = new FakeClock();
  const pool = (side: 'host' | 'guest') =>
    new LanePool({ control: control[side], main: main[side === 'host' ? 'a' : 'b'], peers: peers[side], iceServers: [{ urls: 'stun:stun.example' }], initiator: side === 'host', clock });
  return { host: pool('host'), guest: pool('guest'), peers, clock, control };
}

describe('LanePool', () => {
  it('starts with lane 0 on the main connection', async () => {
    const { host, guest } = setup();
    await settle();
    expect(host.lanes.map((l) => l.id)).toEqual([0]);
    expect(guest.lanes.map((l) => l.id)).toEqual([0]);
    expect(host.lanes[0]!.chunkBytes).toBe(64 * 1024);
  });

  it('negotiates extra lanes in-band, STUN only, and joins their channels end to end', async () => {
    const { host, guest, peers } = setup();
    await settle();
    host.grow(3);
    await settle();

    expect(host.lanes.map((l) => l.id).sort()).toEqual([0, 1, 2, 3]);
    expect(guest.lanes.map((l) => l.id).sort()).toEqual([0, 1, 2, 3]);
    expect(peers.host.peers.every((p) => JSON.stringify(p.config.iceServers) === '[{"urls":"stun:stun.example"}]')).toBe(true);
    expect(peers.guest.peers[0]!.candidates).toHaveLength(1); // Candidates trickle over ctrl.
    expect(host.lanes.find((l) => l.id === 2)!.chunkBytes).toBe(LANES.chunkBytes);

    const received = new Promise<string>((resolve) => guest.lanes.find((l) => l.id === 2)!.channel.addEventListener('message', (e) => resolve(e.data as string)));
    host.lanes.find((l) => l.id === 2)!.channel.send('hello');
    expect(await received).toBe('hello');
  });

  it('only the host opens lanes, and both sides cap how many run', async () => {
    const { host, guest, peers, control } = setup();
    await settle();
    guest.grow(2);
    await settle();
    expect(guest.lanes).toHaveLength(1);

    const max = Math.max(...Object.values(LANES.extra));
    host.grow(max + 3);
    await settle();
    expect(host.lanes).toHaveLength(1 + max);
    expect(guest.lanes).toHaveLength(1 + max);

    // A peer that asks for more anyway is turned down.
    control.host.send({ t: 'lane-sdp', n: 200, d: { type: 'offer', sdp: 'extra' } });
    await settle();
    expect(peers.guest.peers).toHaveLength(max);
  });

  it('drops a lane whose path breaks, on both sides, and replaces it after a pause', async () => {
    const { host, guest, peers, clock } = setup();
    await settle();
    host.grow(1);
    await settle();
    const [lane] = peers.host.peers;
    (lane as FakePeer).setState('disconnected');
    clock.advance(LANES.disconnectGraceMs);
    await settle();
    expect(host.lanes.map((l) => l.id)).toEqual([0]);
    expect(guest.lanes.map((l) => l.id)).toEqual([0]);

    host.grow(1); // Too soon after a drop.
    expect(peers.host.peers).toHaveLength(1);
    clock.advance(LANES.regrowAfterMs);
    host.grow(1);
    await settle();
    expect(host.lanes.map((l) => l.id)).toEqual([0, 2]);
  });

  it('sizes the pool by round-trip time, not by address', () => {
    expect(extraLanesFor(null)).toBe(LANES.extra.near);
    expect(extraLanesFor(2)).toBe(LANES.extra.near);
    expect(extraLanesFor(LANES.nearRttMs + 1)).toBe(LANES.extra.far);
  });

  it('judges distance by the lowest round trip seen, not one inflated by its own traffic', async () => {
    const { host, peers } = setup();
    await settle();
    host.fit(3, true);
    host.fit(LANES.nearRttMs * 10, true); // Queues full of file data.
    await settle();
    expect(peers.host.peers).toHaveLength(LANES.extra.near);
  });

  it('opens no extra lane while the main path is relayed or down', async () => {
    const { host, peers } = setup();
    await settle();
    host.fit(3, false);
    await settle();
    expect(peers.host.peers).toHaveLength(0);
  });

  it('closes every lane', async () => {
    const { host, guest, peers } = setup();
    await settle();
    host.grow(2);
    await settle();
    host.close();
    await settle();
    expect(host.lanes).toHaveLength(0);
    expect(peers.host.peers.every((p) => p.connectionState === 'closed')).toBe(true);
    expect(guest.lanes.map((l) => l.id)).toEqual([]);
  });
});
