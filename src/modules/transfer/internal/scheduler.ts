import type { BlockHasher, Lane } from '../../../contracts/ports';
import { TRANSFER } from '../../../shared/config';
import { Timeout, type Clock } from '../../../shared/timer';
import { writeBlock, writeMark } from './framing';
import type { Pacer } from './flow';
import type { OutgoingFile } from './outgoing';
import type { PacingSelector } from './pacing-selector';

interface Block {
  bytes: Uint8Array<ArrayBuffer>;
  digest: string;
}

interface Job {
  file: OutgoingFile;
  index: number;
  block: Promise<Block>;
}

export interface SchedulerDeps {
  hasher: BlockHasher;
  pacer: Pacer;
  /** Which budget and actuator apply; read once per block. */
  pacing: Pick<PacingSelector, 'actuator' | 'ready'>;
  clock: Clock;
  /** A file is about to send its first block: announce it to the receiver. */
  onStart(file: OutgoingFile): void;
  /** Reading the file failed (e.g. it was deleted after being picked). */
  onError(file: OutgoingFile, error: unknown): void;
  /** A block went to a lane. */
  onWrite(): void;
}

/**
 * Keeps every lane busy. Blocks are taken in file order (oldest file first, so files finish one
 * after another and there is no gap between them), read and hashed a few ahead, and each goes to
 * the emptiest lane: lanes that drain faster get more blocks, which balances parallel paths
 * without measuring them. Lane 0 shares the main connection with calls and control messages, so it
 * carries blocks only when there is no other lane: queued blocks there would delay file offers,
 * acks and call signaling behind them. Lanes hold little (see `TRANSFER.lane*WaterBytes`),
 * so blocks are committed to a lane late. A block can't be taken back from a stalled lane, so one
 * that is overdue (see `TRANSFER.resend`) is sent again on another lane, ahead of new blocks; the
 * receiver keeps whichever copy lands first. At the end of a batch this is what stops one slow lane
 * from holding everything up.
 *
 * Under fine pacing a block goes out chunk by chunk, one block at a time; it always finishes on
 * the lane it started on, and drain markers wait for it (PLAN.md §5.5).
 */
export class BlockScheduler {
  readonly #files: OutgoingFile[] = [];
  readonly #lanes = new Map<number, Lane>();
  readonly #ahead: Job[] = [];
  /** Where the next search for a lane starts, so equally empty lanes take turns. */
  #cursor = 0;
  /** Smoothed send-to-ack time of a block; null until the first ack. */
  #typicalMs: number | null = null;
  readonly #hedge: Timeout;
  #hedgeDue = 0;
  #wake: (() => void) | null = null;
  #running = false;
  #closed = false;
  /** The lane a block is being written to right now, and a drain marker waiting for it. */
  #writing: Lane | null = null;
  #markAfter: number | null = null;
  /** Since when work has been waiting with no open lane at all (FLOW-09). */
  #noLaneSince: number | null = null;

  constructor(private readonly deps: SchedulerDeps) {
    this.#hedge = new Timeout(deps.clock);
  }

  /** How long files have had work waiting with no lane to send it on (0 if they haven't). */
  get noLaneMs(): number {
    return this.#noLaneSince === null ? 0 : this.deps.clock.now() - this.#noLaneSince;
  }

  add(file: OutgoingFile): void {
    this.#files.push(file);
    this.poke();
  }

  remove(file: OutgoingFile): void {
    const index = this.#files.indexOf(file);
    if (index >= 0) this.#files.splice(index, 1);
    this.poke();
  }

  addLane(lane: Lane): void {
    this.#lanes.set(lane.id, lane);
    lane.channel.bufferedAmountLowThreshold = TRANSFER.laneLowWaterBytes;
    lane.channel.addEventListener('bufferedamountlow', () => this.poke());
    this.poke();
  }

  /** The lane closed: blocks it was carrying go back in line for the other lanes. */
  removeLane(id: number): void {
    if (!this.#lanes.delete(id)) return;
    for (const file of this.#files) file.laneLost(id);
    this.poke();
  }

  /** The receiver confirmed a block that took `ms` from send to ack. */
  acked(ms: number | null): void {
    if (ms !== null) this.#typicalMs = this.#typicalMs === null ? ms : this.#typicalMs * (1 - TRANSFER.ackTimeGain) + ms * TRANSFER.ackTimeGain;
    this.poke(); // The in-flight window has room again.
  }

  /**
   * Drain marker `m` behind everything on each open lane: now on lanes between blocks, right after
   * the block on the lane being written to. Returns the lanes that will carry it.
   */
  mark(m: number): number[] {
    const open = this.#open();
    for (const lane of open) {
      if (lane === this.#writing) this.#markAfter = m;
      else this.#sendMark(lane, m);
    }
    return open.map((lane) => lane.id);
  }

  /** Something changed (a lane drained, an ack freed the window, a file or lane came or went). */
  poke(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
    this.deps.pacer.poke(); // Also how a hidden tab's pacer keeps moving between throttled timers.
    this.#watchLanes();
    void this.#pump();
  }

  close(): void {
    this.#closed = true;
    this.#hedge.clear();
    this.#files.length = 0;
    this.#ahead.length = 0;
    this.poke();
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (!this.#closed) {
        this.#prefetch();
        // Overdue blocks first: their files are waiting on them.
        const copy = this.#overdue();
        if (copy) {
          await this.#send(copy.job, copy.lane);
          continue;
        }
        const lane = this.#emptiestLane(null);
        const job = this.#ahead[0];
        if (!job) return; // Woken by a drained lane, an ack, a new file or the overdue timer.
        if (!lane || this.#inFlightBytes() >= TRANSFER.maxInFlightBytes) {
          await new Promise<void>((resolve) => (this.#wake = resolve));
          continue;
        }
        this.#ahead.shift();
        await this.#send(job, lane);
      }
    } finally {
      this.#running = false;
    }
  }

  async #send({ file, index, block }: Job, lane: Lane): Promise<void> {
    let ready: Block;
    try {
      ready = await block;
    } catch (error) {
      if (!file.finished) this.deps.onError(file, error);
      return;
    }
    if (file.finished || !this.#files.includes(file) || !file.pending(index)) return;
    const { pacing, pacer } = this.deps;
    await pacing.ready();
    // The actuator is chosen once per block, so a switch only ever happens between blocks.
    const chunks = await pacer.admit(ready.bytes.byteLength, pacing.actuator);
    if (!this.#lanes.has(lane.id) || lane.channel.readyState !== 'open') return file.requeue(index);
    this.#writing = lane;
    try {
      await writeBlock(lane, { t: 'blk', f: file.id, i: index, n: ready.bytes.byteLength, h: ready.digest }, ready.bytes, chunks);
      file.sent(index, lane.id);
      this.deps.onWrite();
    } catch {
      // Half a block may be on the wire; the lane's framing can't be trusted any more.
      file.requeue(index);
      lane.channel.close();
    } finally {
      this.#writing = null;
      this.#flushMark(lane);
    }
  }

  #flushMark(lane: Lane): void {
    const m = this.#markAfter;
    this.#markAfter = null;
    if (m !== null && lane.channel.readyState === 'open') this.#sendMark(lane, m);
  }

  #sendMark(lane: Lane, m: number): void {
    try {
      writeMark(lane, m);
    } catch {
      lane.channel.close(); // Its answer will never come, and the drain fails safe.
    }
  }

  #prefetch(): void {
    while (this.#ahead.length < TRANSFER.readAheadBlocks) {
      const next = this.#nextBlock();
      if (!next) return;
      const block = this.#read(next.file, next.index);
      block.catch(() => undefined); // Handled when the job reaches the front.
      this.#ahead.push({ ...next, block });
    }
  }

  /**
   * Another copy of the block that has waited longest for its ack, once it is overdue, on the
   * emptiest other lane (its own only if there is no other). Null if there is none yet: then a
   * wake-up is set for when it will be due, or a lane draining will bring us back.
   */
  #overdue(): { job: Job; lane: Lane } | null {
    if (this.#typicalMs === null) return null;
    let best: { file: OutgoingFile; index: number; sentAt: number; lane: number | undefined } | null = null;
    for (const file of this.#files) {
      const candidate = file.finished ? null : file.hedgeCandidate();
      if (candidate && (!best || candidate.sentAt < best.sentAt)) best = { file, ...candidate };
    }
    if (!best) return null;
    const { factor, minMs } = TRANSFER.resend[this.#ahead.length ? 'midway' : 'endgame'];
    const due = best.sentAt + Math.max(minMs, this.#typicalMs * factor);
    const now = this.deps.clock.now();
    if (due > now) {
      this.#wakeAt(due, now);
      return null;
    }
    const lane = this.#emptiestLane(best.lane ?? null);
    if (!lane) return null;
    best.file.hedged(best.index);
    return { job: { file: best.file, index: best.index, block: this.#read(best.file, best.index) }, lane };
  }

  #wakeAt(due: number, now: number): void {
    if (this.#hedge.pending && this.#hedgeDue <= due) return;
    this.#hedgeDue = due;
    this.#hedge.set(() => this.poke(), due - now);
  }

  #nextBlock(): { file: OutgoingFile; index: number } | null {
    for (const file of this.#files) {
      if (file.finished) continue;
      if (!file.started) this.deps.onStart(file);
      const index = file.take();
      if (index !== null) return { file, index };
    }
    return null;
  }

  async #read(file: OutgoingFile, index: number): Promise<Block> {
    const { start, end } = file.range(index);
    const bytes = new Uint8Array(await file.file.slice(start, end).arrayBuffer());
    return { bytes, digest: await this.deps.hasher.digest(bytes) };
  }

  #open(): Lane[] {
    return [...this.#lanes.values()].filter((lane) => lane.channel.readyState === 'open');
  }

  /** The open lane with the least queued (ties take turns), skipping `avoid` unless it's the only one. */
  #emptiestLane(avoid: number | null): Lane | null {
    const open = this.#open();
    const others = open.filter((lane) => lane.id !== avoid);
    const usable = others.length ? others : open;
    const lanes = usable.some((lane) => lane.id !== 0) ? usable.filter((lane) => lane.id !== 0) : usable;
    let best = -1;
    for (let k = 0; k < lanes.length; k++) {
      const index = (this.#cursor + k) % lanes.length;
      const { bufferedAmount } = lanes[index]!.channel;
      if (bufferedAmount >= TRANSFER.laneHighWaterBytes) continue;
      if (best < 0 || bufferedAmount < lanes[best]!.channel.bufferedAmount) best = index;
    }
    if (best < 0) return null;
    this.#cursor = best + 1;
    return lanes[best]!;
  }

  /** Work waiting with no open lane at all is not "just waiting": the watchdog counts it. */
  #watchLanes(): void {
    const waiting = this.#files.some((file) => !file.finished && !file.complete);
    if (!waiting || this.#open().length) this.#noLaneSince = null;
    else this.#noLaneSince ??= this.deps.clock.now();
  }

  #inFlightBytes(): number {
    let total = 0;
    for (const file of this.#files) total += file.inFlightBytes;
    return total;
  }
}
