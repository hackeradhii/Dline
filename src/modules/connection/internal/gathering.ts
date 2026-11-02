import { systemClock, Timeout, type Clock } from '../../../shared/timer';

/**
 * Links can't trickle candidates, so link mode waits for ICE gathering to finish, capped.
 * Resolves early on `complete`; otherwise uses whatever was gathered by the deadline.
 */
export function waitForGathering(pc: RTCPeerConnection, timeoutMs: number, clock: Clock = systemClock): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = new Timeout(clock);
    const done = (): void => {
      timer.clear();
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = (): void => {
      if (pc.iceGatheringState === 'complete') done();
    };
    timer.set(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}
