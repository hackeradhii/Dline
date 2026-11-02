import { FLOW } from '../../../shared/config';
import type { FlowState } from './flow-controller';
import type { PacingMode } from './pacing-selector';

/** One decision as recorded: numbers only, never addresses, names or file data. */
export interface TraceRecord {
  /** Monotonic time, ms. */
  t: number;
  mode: PacingMode;
  state: FlowState;
  /** Queueing delay of the sample and its average, ms. */
  qd: number;
  qdAvg: number;
  rtt: number;
  /** Bytes/s: delivery measured at the receiver, Flow's budget, the legacy budget, the one in force. */
  delivery: number;
  rate: number | null;
  legacy: number | null;
  applied: number | null;
  call: boolean;
  /** Media send rate, bits/s. */
  media: number;
  lanes: number;
  /** Queueing-delay target and the path's own noise, ms. */
  target: number;
  noise: number;
  /** What the call reserve keeps, bytes/s; null while it is off or the bottleneck unknown. */
  reserve: number | null;
}

/** One validation drain: when it held writes, and whether it proved the base (else it failed safe). */
interface DrainRecord {
  start: number;
  end: number;
  validated: boolean;
}

/** Keeps the last `FLOW.traceWindowMs` of `items`, by `time`. */
function keepRecent<T>(items: T[], item: T, time: (item: T) => number): void {
  items.push(item);
  while (time(item) - time(items[0]!) > FLOW.traceWindowMs) items.shift();
}

/**
 * The last two minutes of decisions and drains, for "Save trace" (PLAN.md §5.7). Shadow runs show
 * both budgets side by side, which is what gate G1 needs.
 */
export class FlowTrace {
  readonly #records: TraceRecord[] = [];
  readonly #drains: DrainRecord[] = [];

  add(record: TraceRecord): void {
    keepRecent(this.#records, record, (r) => r.t);
  }

  addDrain(drain: DrainRecord): void {
    keepRecent(this.#drains, drain, (d) => d.end);
  }

  get records(): readonly TraceRecord[] {
    return this.#records;
  }

  get drains(): readonly DrainRecord[] {
    return this.#drains;
  }

  toJSON(): { version: 2; windowMs: number; records: readonly TraceRecord[]; drains: readonly DrainRecord[] } {
    return { version: 2, windowMs: FLOW.traceWindowMs, records: this.#records, drains: this.#drains };
  }
}
