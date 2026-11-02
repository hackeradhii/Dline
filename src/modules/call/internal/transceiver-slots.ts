import type { TransceiverHost } from '../../../contracts/ports';

export type MediaKind = 'audio' | 'video';

/** The most video to send: its shorter side (360 for 360p) and its bitrate. */
export interface VideoCap {
  maxShortSide: number;
  maxBitrateBps: number;
}
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

  /**
   * Applies `cap` to the video sender (null lifts it) through its encoding parameters: no
   * renegotiation. The downscale is taken from `track`'s own size. Returns whether it was applied.
   */
  async capVideo(cap: VideoCap | null, track: MediaStreamTrack | null): Promise<boolean> {
    const sender = this.find('video')?.sender;
    const parameters = sender?.getParameters();
    const encoding = parameters?.encodings?.[0];
    if (!sender || !parameters || !encoding) return false;
    if (cap) {
      const { width, height } = track?.getSettings() ?? {};
      const shortSide = Math.min(width ?? cap.maxShortSide, height ?? cap.maxShortSide);
      encoding.maxBitrate = cap.maxBitrateBps;
      encoding.scaleResolutionDownBy = Math.max(1, shortSide / cap.maxShortSide);
    } else {
      delete encoding.maxBitrate;
      encoding.scaleResolutionDownBy = 1;
    }
    try {
      await sender.setParameters(parameters);
      return true;
    } catch {
      return false; // Not supported here: the call goes on uncapped.
    }
  }

  remoteStream(): MediaStream | null {
    const tracks = KINDS.map((kind) => this.find(kind)?.receiver.track).filter((t): t is MediaStreamTrack => !!t);
    return tracks.length ? new MediaStream(tracks) : null;
  }
}
