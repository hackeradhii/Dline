import { describe, expect, it } from 'vitest';
import type { VideoCap } from './transceiver-slots';
import { VideoCapper } from './video-capper';

const CAP: VideoCap = { maxShortSide: 360, maxBitrateBps: 500_000 };
const track = (): MediaStreamTrack => ({ kind: 'video' }) as MediaStreamTrack;

/** Slots whose `capVideo` succeeds unless `reject` is set; records what was applied. */
function setup(initial: MediaStreamTrack | null = track()) {
  const state = { track: initial, reject: false, hasSender: true };
  const applied: Array<[VideoCap | null, MediaStreamTrack | null]> = [];
  const reported: Array<VideoCap | null> = [];
  const slots = {
    capVideo: async (cap: VideoCap | null, t: MediaStreamTrack | null) => (applied.push([cap, t]), !state.reject),
    find: () => (state.hasSender ? ({} as RTCRtpTransceiver) : undefined),
  };
  const capper = new VideoCapper(slots, () => state.track, (cap) => reported.push(cap));
  return { capper, state, applied, reported };
}

describe('VideoCapper (Files first)', () => {
  it('applies the wanted cap to the track being sent and reports it; lifting reports none', async () => {
    const { capper, applied, reported } = setup();
    await capper.want(CAP);
    await capper.want(null);
    expect(applied.map(([cap]) => cap)).toEqual([CAP, null]);
    expect(reported).toEqual([CAP, null]);
  });

  it('with no track to send (no call), wants nothing applied', async () => {
    const { capper, applied, reported } = setup(null);
    await capper.want(CAP);
    expect(applied).toEqual([]);
    expect(reported).toEqual([]);
  });

  it('skips a sync that changes nothing, but re-applies for a new track', async () => {
    const { capper, state, applied } = setup();
    await capper.want(CAP);
    await capper.sync();
    expect(applied).toHaveLength(1);
    state.track = track(); // Camera flipped.
    await capper.sync();
    expect(applied).toHaveLength(2);
  });

  it('a rejected change reports none and is tried again on the next sync, not skipped (FF-INSPECT-01)', async () => {
    const { capper, state, applied, reported } = setup();
    state.reject = true;
    await capper.want(CAP);
    expect(reported).toEqual([]);
    state.reject = false;
    await capper.sync();
    expect(applied).toHaveLength(2);
    expect(reported).toEqual([CAP]);
  });

  it('withdraws an applied cap before changing it, so nothing claims a cap the sender lacks (FF-REVIEW-03)', async () => {
    const { capper, state, reported } = setup();
    await capper.want(CAP);
    state.track = track();
    await capper.sync();
    expect(reported).toEqual([CAP, null, CAP]);
  });
});
