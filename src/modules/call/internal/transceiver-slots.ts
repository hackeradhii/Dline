import type { TransceiverHost } from '../../../contracts/ports';

export type MediaKind = 'audio' | 'video';
const KINDS: readonly MediaKind[] = ['audio', 'video'];

/**
 * One audio and one video transceiver per connection, created once and reused for every call
 * (replaceTrack + direction), so the SDP never grows call after call.
 */
export class TransceiverSlots {
  constructor(private readonly host: TransceiverHost) {}

  find(kind: MediaKind): RTCRtpTransceiver | undefined {
    return this.host.getTransceivers().find((t) => t.direction !== 'stopped' && t.receiver.track.kind === kind);
  }

  get ready(): boolean {
    return KINDS.every((kind) => this.find(kind));
  }

  /**
   * Puts `track` (or nothing, to only receive) on the slot for `kind`.
   * Only the caller creates missing slots; the callee waits for them to arrive with the offer.
   */
  async attach(kind: MediaKind, track: MediaStreamTrack | null, mayCreate: boolean): Promise<void> {
    const transceiver = this.find(kind);
    if (!transceiver) {
      if (mayCreate) this.host.addTransceiver(track ?? kind, { direction: track ? 'sendrecv' : 'recvonly' });
      return;
    }
    transceiver.direction = track ? 'sendrecv' : 'recvonly';
    await transceiver.sender.replaceTrack(track);
  }

  async replace(kind: MediaKind, track: MediaStreamTrack | null): Promise<void> {
    await this.find(kind)?.sender.replaceTrack(track);
  }

  /** End of call: stop sending and receiving, but keep the slots for next time. */
  async park(): Promise<void> {
    for (const kind of KINDS) {
      const transceiver = this.find(kind);
      if (!transceiver) continue;
      await transceiver.sender.replaceTrack(null);
      transceiver.direction = 'inactive';
    }
  }

  remoteStream(): MediaStream | null {
    const tracks = KINDS.map((kind) => this.find(kind)?.receiver.track).filter((t): t is MediaStreamTrack => !!t);
    return tracks.length ? new MediaStream(tracks) : null;
  }
}
