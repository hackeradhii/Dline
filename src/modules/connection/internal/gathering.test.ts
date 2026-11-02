import { describe, expect, it } from 'vitest';
import { timed } from '../../../shared/testing/drive';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { waitForGathering } from './gathering';

/** A connection whose gathering state the test moves on. */
class FakePc extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'gathering';

  complete(): void {
    this.iceGatheringState = 'complete';
    this.dispatchEvent(new Event('icegatheringstatechange'));
  }
}

const asPc = (pc: FakePc) => pc as unknown as RTCPeerConnection;

describe('waitForGathering (link mode can’t trickle)', () => {
  it('resolves as soon as gathering completes', async () => {
    const clock = new FakeClock();
    const pc = new FakePc();
    const done = waitForGathering(asPc(pc), 3_000, clock);
    clock.setTimeout(() => pc.complete(), 400);
    expect(await timed(clock, done)).toBe(400);
  });

  it('gives up at the deadline and uses what was gathered', async () => {
    const clock = new FakeClock();
    expect(await timed(clock, waitForGathering(asPc(new FakePc()), 3_000, clock))).toBe(3_000);
  });

  it('does not wait at all when gathering already finished', async () => {
    const pc = new FakePc();
    pc.iceGatheringState = 'complete';
    const clock = new FakeClock();
    expect(await timed(clock, waitForGathering(asPc(pc), 3_000, clock))).toBe(0);
  });
});
