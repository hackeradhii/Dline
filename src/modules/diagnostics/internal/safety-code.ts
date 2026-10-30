import { sdpFingerprint } from '../../../shared/sdp';
import { WORDS } from './wordlist';

/**
 * Four words derived from both DTLS certificate fingerprints. Both people see the same words only if
 * nobody swapped a link in transit; comparing them aloud rules out a man-in-the-middle.
 */
export async function safetyCode(localSdp: string, remoteSdp: string): Promise<string[] | null> {
  const local = sdpFingerprint(localSdp);
  const remote = sdpFingerprint(remoteSdp);
  if (!local || !remote) return null;
  const material = [local, remote]
    .map((fp) => `${fp.algorithm} ${fp.hex}`)
    .sort()
    .join('|');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
  return [...digest.slice(0, 4)].map((b) => WORDS[b]!);
}
