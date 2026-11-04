import { isFinished, type TransferDirection } from '../../../contracts/transfer';
import { METRICS } from '../../../shared/config';

/** The slice of a transfer the tally reads (a `TransferItem` fits). */
export interface TallyItem {
  readonly id: string;
  readonly direction: TransferDirection;
  readonly bytes: number;
  readonly status: string;
  /** When bytes started flowing, or null while queued. */
  readonly startedAt: number | null;
  /** From the first byte until now, or until it finished. */
  readonly elapsedMs: number;
}

/** One direction of a session, bytes per second for the rates. */
export interface SideTally {
  bytes: number;
  /** Files that arrived (or were delivered) intact. */
  files: number;
  failed: number;
  /** The live speed: the last few ticks, averaged. */
  bps: number;
  /** Over the time files were actually moving (from each file's own timing, overlaps counted once), so idle minutes don't dilute it. */
  avgBps: number;
  /** The busiest second so far, and never below the average (a file shorter than a second can't fill one). */
  peakBps: number;
  /** The live speed, oldest first, one value per tick (for the graph). */
  history: readonly number[];
}

export interface TallySnapshot {
  up: SideTally;
  down: SideTally;
}

const mean = (values: readonly number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const keepLast = (values: number[], n: number): void => void values.splice(0, Math.max(0, values.length - n));

/** How long at least one of the intervals was open: overlaps count once. */
function coveredMs(intervals: Array<[number, number]>): number {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of intervals.sort((x, y) => x[0] - y[0])) {
    total += Math.max(0, to - Math.max(from, end));
    end = Math.max(end, to);
  }
  return total;
}

/** One direction: the latest state of each file, turned into speeds tick by tick. */
class Side {
  readonly #items = new Map<string, TallyItem>();
  readonly #ended = new Set<string>();
  readonly #rates: number[] = [];
  readonly #history: number[] = [];
  #files = 0;
  #failed = 0;
  #counted = 0;
  #peak = 0;

  observe(item: TallyItem): void {
    this.#items.set(item.id, item);
    if (this.#ended.has(item.id) || !isFinished(item.status)) return;
    this.#ended.add(item.id);
    if (item.status === 'done') this.#files++;
    if (item.status === 'failed') this.#failed++;
  }

  tick(elapsedMs: number): void {
    const total = this.#total();
    const moved = Math.max(0, total - this.#counted);
    this.#counted = total;
    const rate = elapsedMs > 0 ? (moved * 1000) / elapsedMs : 0;
    this.#peak = Math.max(this.#peak, rate);
    this.#rates.push(rate);
    keepLast(this.#rates, METRICS.liveWindowTicks);
    this.#history.push(mean(this.#rates));
    keepLast(this.#history, METRICS.historyTicks);
  }

  snapshot(): SideTally {
    const bytes = this.#total();
    const items = [...this.#items.values()];
    const movingMs = coveredMs(items.flatMap((i): Array<[number, number]> => (i.startedAt === null ? [] : [[i.startedAt, i.startedAt + i.elapsedMs]])));
    const avgBps = movingMs > 0 ? (bytes * 1000) / movingMs : 0;
    return {
      bytes,
      files: this.#files,
      failed: this.#failed,
      bps: mean(this.#rates),
      avgBps,
      peakBps: Math.max(this.#peak, avgBps),
      history: [...this.#history],
    };
  }

  #total(): number {
    let sum = 0;
    for (const item of this.#items.values()) sum += item.bytes;
    return sum;
  }
}

/**
 * What a session moved, both ways: totals, live speed, average and peak. Fed with every transfer
 * change and ticked once a second (the stats tick); file bytes only, so call media doesn't count.
 */
export class SessionTally {
  readonly #up = new Side();
  readonly #down = new Side();

  observe(item: TallyItem): void {
    (item.direction === 'out' ? this.#up : this.#down).observe(item);
  }

  /** `elapsedMs` since the last tick (or the start): the caller keeps the session's one clock. */
  tick(elapsedMs: number): TallySnapshot {
    this.#up.tick(elapsedMs);
    this.#down.tick(elapsedMs);
    return this.snapshot();
  }

  snapshot(): TallySnapshot {
    return { up: this.#up.snapshot(), down: this.#down.snapshot() };
  }
}
