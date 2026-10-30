import type { BrowserContext, Page } from '@playwright/test';
import type { Netem, Side } from './netem';

declare global {
  interface Window {
    __netemFront?: (address: string, port: number) => Promise<{ address: string; port: number }>;
    __peers?: Set<RTCPeerConnection>;
  }
}

/**
 * Sends every peer connection in `context` (playing `side`) through the emulator: remote host
 * candidates are swapped for our fronts, and every other candidate is dropped, so the only path
 * between the two profiles is the emulated one. Test-only; the app is untouched.
 */
export async function routeThrough(context: BrowserContext, side: Side, netem: Netem): Promise<void> {
  const other: Side = side === 'a' ? 'b' : 'a';
  // The remote candidates this side receives belong to the other side.
  await context.exposeFunction('__netemFront', (address: string, port: number) => netem.front(other, address, port));
  await context.addInitScript(installShim);
}

/** Runs in the page. Must be self-contained (it is serialised). */
function installShim(): void {
  const proto = RTCPeerConnection.prototype;
  // The promise forms only (the legacy callback overloads confuse `.call`).
  const setRemote = proto.setRemoteDescription as (this: RTCPeerConnection, description?: RTCSessionDescriptionInit) => Promise<void>;
  const addCandidate = proto.addIceCandidate as (this: RTCPeerConnection, candidate?: RTCIceCandidateInit) => Promise<void>;
  // Rewriting is async, so keep each connection's remote operations in call order.
  const chains = new WeakMap<RTCPeerConnection, Promise<unknown>>();
  const peers = (window.__peers = new Set());
  const serial = <T>(pc: RTCPeerConnection, task: () => Promise<T>): Promise<T> => {
    peers.add(pc);
    const run = (chains.get(pc) ?? Promise.resolve()).then(task, task);
    chains.set(pc, run.catch(() => undefined));
    return run;
  };
  const rewrite = async (candidate: string): Promise<string | null> => {
    // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …
    const parts = candidate.split(' ');
    if (parts[2]?.toLowerCase() !== 'udp' || parts[7] !== 'host' || !/^\d+\.\d+\.\d+\.\d+$/.test(parts[4] ?? '')) return null;
    const front = await window.__netemFront!(parts[4]!, Number(parts[5]));
    parts[4] = front.address;
    parts[5] = String(front.port);
    return parts.join(' ');
  };

  proto.setRemoteDescription = function (this: RTCPeerConnection, description?: RTCSessionDescriptionInit) {
    return serial(this, async () => {
      if (!description?.sdp) return setRemote.call(this, description);
      const lines: string[] = [];
      for (const line of description.sdp.split('\r\n')) {
        if (!line.startsWith('a=candidate:')) lines.push(line);
        else {
          const rewritten = await rewrite(line.slice(2));
          if (rewritten) lines.push(`a=${rewritten}`);
        }
      }
      return setRemote.call(this, { type: description.type, sdp: lines.join('\r\n') });
    });
  } as typeof proto.setRemoteDescription;

  proto.addIceCandidate = function (this: RTCPeerConnection, init?: RTCIceCandidateInit | RTCIceCandidate) {
    return serial(this, async () => {
      if (!init?.candidate) return addCandidate.call(this, init);
      const rewritten = await rewrite(init.candidate.replace(/^a=/, ''));
      if (!rewritten) return;
      return addCandidate.call(this, { candidate: rewritten, sdpMid: init.sdpMid, sdpMLineIndex: init.sdpMLineIndex, usernameFragment: init.usernameFragment });
    });
  } as typeof proto.addIceCandidate;
}

/** Peer connections in `page` that are connected right now (the main one plus every lane). */
export function connectedPeers(page: Page): Promise<number> {
  return page.evaluate(() => [...(window.__peers ?? [])].filter((pc) => pc.connectionState === 'connected').length);
}
