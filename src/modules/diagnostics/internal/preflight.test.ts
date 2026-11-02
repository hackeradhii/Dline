import { describe, expect, it } from 'vitest';
import type { PeerFactory } from '../../../contracts/ports';
import { PREFLIGHT } from '../../../shared/config';
import { timed } from '../../../shared/testing/drive';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { probeNetwork } from './preflight';

const SRFLX = 'candidate:1 1 udp 1686052607 203.0.113.7 40000 typ srflx raddr 0.0.0.0 rport 0 generation 0';

/** A probe connection that hands out `candidates`, then end-of-candidates unless `endless`. */
function fakePeers(clock: FakeClock, candidates: string[], endless = false): { peers: PeerFactory; closed: () => boolean } {
  let closed = false;
  const peers = {
    create: () => {
      const pc = new EventTarget();
      const emit = (candidate: string | null) =>
        pc.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: candidate === null ? null : { candidate } }));
      return Object.assign(pc, {
        createDataChannel: () => ({}),
        setLocalDescription: async () => {
          candidates.forEach((c, i) => clock.setTimeout(() => emit(c), 100 * (i + 1)));
          if (!endless) clock.setTimeout(() => emit(null), 100 * (candidates.length + 1));
        },
        close: () => (closed = true),
      });
    },
  } as unknown as PeerFactory;
  return { peers, closed: () => closed };
}

describe('probeNetwork (pre-flight check)', () => {
  it('rates the network from what was gathered, as soon as gathering ends', async () => {
    const clock = new FakeClock();
    const { peers, closed } = fakePeers(clock, [SRFLX]);
    let profile: Awaited<ReturnType<typeof probeNetwork>> | null = null;
    const ms = await timed(clock, probeNetwork([], peers, clock).then((p) => (profile = p)));
    expect(ms).toBe(200);
    expect(profile).not.toBeNull();
    expect(closed()).toBe(true);
  });

  it('stops at its deadline when gathering never ends', async () => {
    const clock = new FakeClock();
    const { peers, closed } = fakePeers(clock, [SRFLX], true);
    expect(await timed(clock, probeNetwork([], peers, clock))).toBe(PREFLIGHT.timeoutMs);
    expect(closed()).toBe(true);
  });
});
