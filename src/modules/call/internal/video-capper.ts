import { SerialQueue } from '../../../shared/async';
import type { TransceiverSlots, VideoCap } from './transceiver-slots';

/** What the capper needs from the slots: apply a cap, and know whether a video sender exists. */
type CapTarget = Pick<TransceiverSlots, 'capVideo' | 'find'>;

/**
 * Files first (PLAN-FILES-FIRST): keeps the video sender's cap in step with the cap wanted and the
 * track being sent. Changes run one at a time, each against the latest wanted cap and track, and
 * `onApplied` reports exactly what the sender has, so Flow's reserve never trusts a cap that isn't
 * there (FF-REVIEW-03).
 */
export class VideoCapper {
  #wanted: VideoCap | null = null;
  #applied: VideoCap | null = null;
  /** The track the last change was made for. */
  #track: MediaStreamTrack | null = null;
  /** A change was rejected, so what the sender really has is unknown: the next sync tries again (FF-INSPECT-01). */
  #unknown = false;
  readonly #queue = new SerialQueue();

  constructor(
    private readonly slots: CapTarget,
    /** The track to cap now: the camera while a call is active, else null (no cap). */
    private readonly track: () => MediaStreamTrack | null,
    private readonly onApplied: (cap: VideoCap | null) => void,
  ) {}

  /** The most the camera may send, or null for no ceiling. */
  want(cap: VideoCap | null): Promise<void> {
    this.#wanted = cap;
    return this.sync();
  }

  /**
   * One serial step: what the sender should have now, applied if it differs from what it has. An
   * applied cap is withdrawn before it is changed, then each step reports what it applied. After a
   * rejection the sender's state is unknown and the step isn't skipped.
   */
  sync(): Promise<void> {
    return this.#queue.run(async () => {
      const track = this.track();
      const want = track ? this.#wanted : null;
      if (!this.#unknown && want === this.#applied && (want === null || track === this.#track)) return;
      this.#publish(null);
      const applied = await this.slots.capVideo(want, track);
      this.#track = track;
      // Rejected: the sender may still have the old cap, so report none (Flow keeps its full reserve)
      // and let the next request or lifecycle step try again, once each, never in a loop.
      this.#unknown = !applied && this.slots.find('video') !== undefined;
      this.#publish(applied ? want : null);
    });
  }

  #publish(cap: VideoCap | null): void {
    if (cap === this.#applied) return;
    this.#applied = cap;
    this.onApplied(cap);
  }
}
