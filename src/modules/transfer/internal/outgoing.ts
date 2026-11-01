import type { FileOffer } from '../../../contracts/transfer';
import type { Clock } from '../../../shared/timer';
import type { TransferRecord } from './record';

const UNSENT = 0;
const IN_FLIGHT = 1;
const ACKED = 2;

/**
 * One file being sent, cut into blocks. Tracks every block: unsent, in flight (and on which lane,
 * so a lane that dies can give its blocks back) or acknowledged by the receiver. Overdue blocks get
 * sent again (`hedgeCandidate`), so a lane stuck in loss recovery, or a block the receiver had to
 * drop, never holds up the file.
 */
export class OutgoingFile {
  readonly blockCount: number;
  readonly #state: Uint8Array;
  readonly #laneOf = new Map<number, number>();
  /** When each in-flight block was last sent (first copy or a later one), oldest first. */
  readonly #sentAt = new Map<number, number>();
  readonly #retry: number[] = [];
  #next = 0;
  #acked = 0;
  #ackedBytes = 0;
  #inFlightBytes = 0;
  #inFlightBlocks = 0;
  #started = false;
  /** Waiting on the receiver since: set while blocks are in flight, reset by every ack (FLOW-02). */
  #waitingSince: number | null = null;

  constructor(
    readonly id: string,
    readonly file: File,
    readonly record: TransferRecord,
    readonly blockBytes: number,
    private readonly clock: Clock,
  ) {
    this.blockCount = Math.ceil(file.size / blockBytes);
    this.#state = new Uint8Array(this.blockCount);
  }

  get offer(): FileOffer {
    return { t: 'file', f: this.id, name: this.file.name, size: this.file.size, mime: this.file.type || 'application/octet-stream', block: this.blockBytes };
  }

  get started(): boolean {
    return this.#started;
  }

  get finished(): boolean {
    return this.record.finished;
  }

  /** Every block has been acknowledged. */
  get complete(): boolean {
    return this.#acked === this.blockCount;
  }

  get inFlightBytes(): number {
    return this.#inFlightBytes;
  }

  /**
   * Time since the receiver last confirmed anything, while blocks are in flight to it. Waiting
   * behind the pacer or the in-flight window doesn't count: a file queued behind slow, paced
   * sending is not stuck.
   */
  get stalledMs(): number {
    return this.#waitingSince === null ? 0 : this.clock.now() - this.#waitingSince;
  }

  start(): void {
    this.#started = true;
    this.record.update({ status: 'transferring' });
  }

  /** The next block to send (re-sends first), or null while all are in flight or acknowledged. */
  take(): number | null {
    while (this.#retry.length) {
      const index = this.#retry.shift()!;
      if (this.#state[index] === UNSENT) return index;
    }
    return this.#next < this.blockCount ? this.#next++ : null;
  }

  /**
   * The in-flight block that has waited longest since its last copy went out, and the lane its
   * first copy took; the scheduler decides whether it is overdue.
   */
  hedgeCandidate(): { index: number; sentAt: number; lane: number | undefined } | null {
    const oldest = this.#sentAt.entries().next();
    if (oldest.done) return null;
    const [index, sentAt] = oldest.value;
    return { index, sentAt, lane: this.#laneOf.get(index) };
  }

  /** Another copy of `index` is on its way: it waits its turn again. */
  hedged(index: number): void {
    this.#sentAt.delete(index);
    this.#sentAt.set(index, this.clock.now());
  }

  /** Still worth sending: not yet acknowledged. */
  pending(index: number): boolean {
    return this.#state[index] !== ACKED;
  }

  range(index: number): { start: number; end: number } {
    const start = index * this.blockBytes;
    return { start, end: Math.min(this.file.size, start + this.blockBytes) };
  }

  sent(index: number, laneId: number): void {
    if (this.#state[index] !== UNSENT) return;
    this.#state[index] = IN_FLIGHT;
    this.#laneOf.set(index, laneId);
    this.#sentAt.set(index, this.clock.now());
    this.#inFlightBytes += this.#length(index);
    if (this.#inFlightBlocks++ === 0) this.#waitingSince = this.clock.now();
  }

  /** Gives a block back to be sent again: it was never sent, or its lane closed before the ack. */
  requeue(index: number): void {
    if (this.#state[index] === ACKED) return;
    if (this.#state[index] === IN_FLIGHT) this.#leaveFlight(index);
    this.#state[index] = UNSENT;
    this.#forget(index);
    this.#retry.push(index);
  }

  laneLost(laneId: number): void {
    for (const [index, lane] of [...this.#laneOf]) if (lane === laneId) this.requeue(index);
  }

  /** Returns how long the block took from its last send to acknowledgement, if it was in flight. */
  ack(index: number): number | null {
    if (index >= this.blockCount || this.#state[index] === ACKED) return null;
    const sentAt = this.#sentAt.get(index);
    if (this.#state[index] === IN_FLIGHT) this.#leaveFlight(index);
    this.#state[index] = ACKED;
    this.#forget(index);
    this.#acked++;
    this.#ackedBytes += this.#length(index);
    if (this.#waitingSince !== null) this.#waitingSince = this.clock.now(); // Progress: the clock starts over.
    this.record.progress(this.#ackedBytes);
    if (this.complete) this.record.update({ status: 'verifying' });
    return sentAt === undefined ? null : this.clock.now() - sentAt;
  }

  #leaveFlight(index: number): void {
    this.#inFlightBytes -= this.#length(index);
    if (--this.#inFlightBlocks === 0) this.#waitingSince = null;
  }

  #forget(index: number): void {
    this.#laneOf.delete(index);
    this.#sentAt.delete(index);
  }

  #length(index: number): number {
    const { start, end } = this.range(index);
    return end - start;
  }
}
