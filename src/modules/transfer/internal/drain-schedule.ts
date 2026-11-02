import { FLOW } from '../../../shared/config';

/** A drain in progress: where it came from, and its deadline. */
export interface Drain {
  from: 'unlimited' | 'controlled';
  rate: number;
  delivery: number;
  until: number;
}

/**
 * Rule 6's bookkeeping (PLAN.md §5.3): when the base delay needs proving on an empty path, the
 * drain in progress, and the retry after one that failed. The controller owns what a drain does to
 * the rate; this only says when one is due and remembers where it came from.
 */
export class DrainSchedule {
  #drain: Drain | null = null;
  #retryAt = -Infinity;
  /** When a reset while sending made the base suspect (null: it isn't): it is validated before it is trusted again. */
  #suspectSince: number | null = null;

  /** `allowed`: validation drains run only while Flow is in charge, never in shadow mode. */
  constructor(private readonly allowed: boolean) {}

  /** The drain in progress, or null. */
  get active(): Drain | null {
    return this.#drain;
  }

  /** The estimates were reset at `at` while sending (null: not sending): the new base is suspect until a clean sample. */
  suspect(at: number | null): void {
    this.#suspectSince = at;
  }

  /** Time to prove the base: suspect since a reset, or no clean sample for `baseValidateMs` of sending. */
  due(at: number, lastCleanAt: number, sendingSince: number | null): boolean {
    if (!this.allowed || this.#drain || sendingSince === null || at < this.#retryAt) return false;
    // After a reset while sending, until a clean sample comes: a failed drain is tried again as soon as `drainRetryMs` allows.
    const suspect = this.#suspectSince !== null && lastCleanAt < this.#suspectSince;
    return suspect || at - Math.max(lastCleanAt, sendingSince) >= FLOW.baseValidateMs;
  }

  /** Holds new writes from `at`, for at most `drainMaxMs` in all. */
  begin(from: Drain['from'], rate: number, delivery: number, at: number): void {
    this.#drain = { from, rate, delivery, until: at + FLOW.drainMaxMs };
  }

  /** The drain ended: validated, the base is trusted; otherwise another attempt waits `drainRetryMs`. Returns the drain that ended. */
  finish(validated: boolean, at: number): Drain | null {
    const drain = this.#drain;
    if (!drain) return null;
    this.#drain = null;
    if (validated) this.#suspectSince = null;
    else this.#retryAt = at + FLOW.drainRetryMs;
    return drain;
  }
}
