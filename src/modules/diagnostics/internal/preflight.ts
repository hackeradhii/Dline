import type { PeerFactory } from '../../../contracts/ports';
import { PREFLIGHT } from '../../../shared/config';
import { parseCandidate, type ParsedCandidate } from '../../../shared/net';
import { systemClock, Timeout, type Clock } from '../../../shared/timer';
import { browserPeerFactory } from '../../connection';
import { analyzeCandidates, type NetworkProfile } from './network-analysis';

/**
 * ~2 s pre-flight check before pairing: gathers candidates against the STUN servers and rates this
 * network Good / Risky / Blocked, so the user knows up front whether a direct path is likely.
 */
export async function probeNetwork(iceServers: RTCIceServer[], peers: PeerFactory = browserPeerFactory, clock: Clock = systemClock): Promise<NetworkProfile> {
  const pc = peers.create({ iceServers });
  const candidates: ParsedCandidate[] = [];
  const timer = new Timeout(clock);
  try {
    pc.createDataChannel('probe');
    const gathered = new Promise<void>((resolve) => {
      timer.set(resolve, PREFLIGHT.timeoutMs);
      pc.addEventListener('icecandidate', ({ candidate }) => {
        if (!candidate) {
          timer.clear();
          return resolve();
        }
        const parsed = parseCandidate(candidate.candidate);
        if (parsed) candidates.push(parsed);
      });
    });
    await pc.setLocalDescription();
    await gathered;
  } finally {
    timer.clear();
    pc.close();
  }
  return analyzeCandidates(candidates);
}
