import { Emitter } from '../../../shared/emitter';

/**
 * Proves that every lane has delivered everything sent on it before a point in time (PLAN.md §5.3
 * rule 6 step 2, FLOW-14). Counting unique blocks can't: a hedged block clears on its first ack
 * while other copies still travel, and a cancelled file's bytes keep moving after it is gone. So a
 * marker goes behind everything on every open lane; lanes are reliable and ordered, so once the
 * receiver has answered a lane's marker, all of that lane's earlier bytes have arrived.
 *
 * A lane that closes before answering fails the attempt: it has its own connection, maybe its own
 * queue, and nothing proves its packets left the path. Lanes closed before the start aren't asked.
 */
export class LaneBarrier {
  readonly events = new Emitter<{ passed: undefined; failed: undefined }>();
  #marker = 0;
  #waiting: Set<number> | null = null;

  constructor(
    /** Puts marker `m` behind everything on each open lane; returns the lanes that will carry it. */
    private readonly mark: (m: number) => number[],
  ) {}

  start(): void {
    const lanes = this.mark(++this.#marker);
    this.#waiting = new Set(lanes);
    if (!lanes.length) this.#finish('passed');
  }

  /** The receiver read marker `m` on lane `n`. */
  answered(m: number, n: number): void {
    if (m !== this.#marker || !this.#waiting?.delete(n)) return;
    if (!this.#waiting.size) this.#finish('passed');
  }

  laneClosed(n: number): void {
    if (this.#waiting?.has(n)) this.#finish('failed');
  }

  cancel(): void {
    this.#waiting = null;
  }

  #finish(outcome: 'passed' | 'failed'): void {
    this.#waiting = null;
    this.events.emit(outcome, undefined);
  }
}
