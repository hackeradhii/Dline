import { FLOW } from '../../../shared/config';
import { Timeout, type Clock } from '../../../shared/timer';

/** How long without an echo counts as a gap in the feedback (rule 8). */
export const feedbackGapMs = (sRtt: number): number => Math.max(FLOW.feedbackGapRtts * sRtt, FLOW.feedbackTimeoutMs);

export interface FeedbackWatchDeps {
  clock: Clock;
  /** A gap went by without an echo. */
  gap(now: number): void;
  /** Nothing heard for `resetAfterGapMs`: once, until an echo comes again. */
  silent(now: number): void;
  /** After every gap: the budget may have changed. */
  changed(): void;
}

/**
 * Rule 8: while files go out to a peer that answers, an echo is due every gap. Armed when files
 * start going out and after every echo while sending; silence is counted from the later of the
 * last echo and the transfer's start (echoes may have stopped before it, PLAN.md §5.3).
 */
export class FeedbackWatch {
  readonly #timer: Timeout;
  #sending = false;
  #since = -Infinity;
  #heardAt = -Infinity;
  #silenced = false;

  constructor(private readonly deps: FeedbackWatchDeps) {
    this.#timer = new Timeout(deps.clock);
  }

  /** Files started going out at `at`. */
  start(at: number): void {
    this.#sending = true;
    this.#since = at;
  }

  stop(): void {
    this.#sending = false;
    this.#timer.clear();
  }

  /** An echo came. */
  heard(at: number): void {
    this.#heardAt = at;
    this.#silenced = false;
  }

  /** Waits one gap (for the round trip `sRtt`) for the next echo; nothing while not sending. */
  arm(sRtt: number): void {
    this.#timer.clear();
    if (!this.#sending) return;
    const gap = feedbackGapMs(sRtt);
    const fire = (): void => {
      const now = this.deps.clock.now();
      this.deps.gap(now);
      if (now - Math.max(this.#heardAt, this.#since) >= FLOW.resetAfterGapMs && !this.#silenced) {
        this.#silenced = true;
        this.deps.silent(now);
      }
      this.deps.changed();
      this.#timer.set(fire, gap);
    };
    this.#timer.set(fire, gap);
  }
}
