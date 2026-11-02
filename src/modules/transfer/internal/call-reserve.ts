import { FLOW } from '../../../shared/config';
import { Windowed } from '../../../shared/windowed';

/**
 * Call first (PLAN.md §5.4): the bottleneck's capacity, and the share of it the call keeps.
 *
 * The capacity C is what the bottleneck carried, files plus media, over the time it stayed busy
 * in the last 5 s: a busy bottleneck carries exactly its capacity. Trusted for 30 s afterwards.
 * Not the largest of short readings: those are noisy, and their peak overstated C by a third on
 * the bench, so files took the call's share. The reserve is headroom over the media's measured
 * rate, or over the 720p (or audio-only) ceiling while the media is below it, so a video that backed
 * off has room to come back; at most 70 % of C so files never stop.
 * The browser's bandwidth estimate is not used: it describes the media's own ramp-up.
 */
export class CallReserve {
  readonly #carried = new Windowed('sum', FLOW.capacityWindowMs, FLOW.capacityBuckets);
  readonly #busyMs = new Windowed('sum', FLOW.capacityWindowMs, FLOW.capacityBuckets);
  #last: { value: number; at: number } | null = null;

  /** The bottleneck stayed busy for `ms`: `fileBytes` arrived, and the media went at `mediaBitsPerSecond`. */
  busy(fileBytes: number, ms: number, mediaBitsPerSecond: number, at: number): void {
    this.#carried.add(fileBytes + (mediaBitsPerSecond / 8) * (ms / 1000), at);
    this.#busyMs.add(ms, at);
    const recent = this.#measured(at);
    if (recent !== null) this.#last = { value: recent, at };
  }

  /** Capacity in bytes/s, or null if it hasn't been measured in the last 30 s. */
  capacity(at: number): number | null {
    const recent = this.#measured(at);
    if (recent !== null) return recent;
    return this.#last && at - this.#last.at <= FLOW.capacityMaxAgeMs ? this.#last.value : null;
  }

  /** Bytes/s the call keeps out of `capacity`; a video capped (Files first) keeps room for a multiple of its cap. */
  reserve(mediaBitsPerSecond: number, videoOn: boolean, capacity: number, videoCapBps: number | null = null): number {
    const ceiling = videoOn ? Math.min(FLOW.videoReserveBps, FLOW.cappedVideoReserve * (videoCapBps ?? Infinity)) : FLOW.audioReserveBps;
    return Math.min(FLOW.maxReserveShare * capacity, (FLOW.mediaHeadroom * Math.max(mediaBitsPerSecond, ceiling)) / 8);
  }

  reset(): void {
    this.#carried.reset();
    this.#busyMs.reset();
    this.#last = null;
  }

  /** What the window's busy time carried per second, once there is enough of it. */
  #measured(at: number): number | null {
    const busyMs = this.#busyMs.value(at) ?? 0;
    return busyMs >= FLOW.capacityBusyMs ? (this.#carried.value(at)! * 1000) / busyMs : null;
  }
}
