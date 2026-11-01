import type { BlockHasher, ControlChannel, Lane, LaneSource } from '../../../contracts/ports';
import type { BlockHeader, FileOffer, TransferControl } from '../../../contracts/transfer';
import { randomId } from '../../../shared/bytes';
import { TRANSFER } from '../../../shared/config';
import { Disposer, Emitter } from '../../../shared/emitter';
import { alwaysVisible, monotonicClock, systemClock, type Clock, type Visibility } from '../../../shared/timer';
import { EarlyBlocks } from './early-blocks';
import { Pacer } from './flow';
import { FlowSession, type FlowSessionInputs, type PacingStatus } from './flow-session';
import type { FlowTrace } from './flow-trace';
import { BlockReader } from './framing';
import { webCryptoHasher } from './hasher';
import { IncomingFile } from './incoming';
import { OutgoingFile } from './outgoing';
import type { PacingMode } from './pacing-selector';
import type { RatePolicy } from './rate-policy';
import { TransferRecord, type TransferItem } from './record';
import { BlockScheduler } from './scheduler';
import { defaultSinkFactory, type SinkFactory } from './sinks';

export interface TransferDeps {
  /** File offers, acknowledgements and cancels travel here, and Flow's probes and echoes. */
  control: ControlChannel;
  /** File blocks travel here, spread over every open lane. */
  lanes: LaneSource;
  hasher?: BlockHasher;
  sinks?: SinkFactory;
  /** Today's upload budget (the legacy policy), in force unless Flow is. Default: none. */
  legacy?: RatePolicy;
  /** Which file pacing runs (PLAN.md §5.6). Default: legacy. */
  pacing?: PacingMode;
  clock?: Clock;
  /** Flow's timing; defaults to `clock` when one is given (tests), else the monotonic clock. */
  flowClock?: Clock;
  visibility?: Visibility;
}

const NO_BUDGET: RatePolicy = { limit: null };

/**
 * Sends files in order with no gap between them, spreading each file's blocks over all lanes, and
 * receives any number at once. Emits `changed` whenever an item's progress or status changes.
 */
export class TransferManager {
  readonly events = new Emitter<{ changed: TransferItem }>();
  readonly #outgoing = new Map<string, OutgoingFile>();
  readonly #incoming = new Map<string, IncomingFile>();
  /** Incoming files that ended (or were cancelled before their offer arrived). */
  readonly #ended = new Set<string>();
  readonly #early = new EarlyBlocks();
  readonly #flow: FlowSession;
  readonly #scheduler: BlockScheduler;
  readonly #pacer: Pacer;
  readonly #hasher: BlockHasher;
  readonly #sinks: SinkFactory;
  readonly #clock: Clock;
  readonly #disposer = new Disposer();

  constructor(private readonly deps: TransferDeps) {
    this.#hasher = deps.hasher ?? webCryptoHasher;
    this.#sinks = deps.sinks ?? defaultSinkFactory;
    this.#clock = deps.clock ?? systemClock;
    const flowClock = deps.flowClock ?? deps.clock ?? monotonicClock;
    const visibility = deps.visibility ?? alwaysVisible;
    this.#flow = new FlowSession({
      mode: deps.pacing ?? 'legacy',
      control: deps.control,
      legacy: deps.legacy ?? NO_BUDGET,
      clock: flowClock,
      visibility,
      mark: (m) => this.#scheduler.mark(m),
      pacerWaitAt: () => this.#pacer.lastWaitAt,
      laneCount: () => deps.lanes.lanes.length,
      changed: () => this.#pacer.poke(),
    });
    const selector = this.#flow.selector;
    this.#pacer = new Pacer(() => selector.limit, flowClock, visibility);
    this.#scheduler = new BlockScheduler({
      hasher: this.#hasher,
      pacer: this.#pacer,
      pacing: selector,
      clock: this.#clock,
      onStart: (file) => {
        file.start();
        this.#send(file.offer);
      },
      onError: (file) => this.#endOutgoing(file, { status: 'failed', error: 'unreadable' }, true),
      onWrite: () => this.#flow.wrote(),
    });

    const { control, lanes } = deps;
    const on = this.#disposer.add.bind(this.#disposer);
    on(control.on('file', (offer) => this.#onOffer(offer)));
    on(control.on('file-ack', ({ f, i }) => this.#onAck(f, i)));
    on(control.on('file-done', ({ f, ok }) => this.#onDone(f, ok)));
    on(control.on('file-cancel', ({ f }) => this.#onCancelled(f)));
    for (const lane of lanes.lanes) this.#attach(lane);
    on(lanes.onLane((lane) => this.#attach(lane)));
    const watchdog = this.#clock.setInterval(() => this.#checkStalls(), TRANSFER.stallCheckMs);
    on(() => this.#clock.clearInterval(watchdog));
  }

  send(files: Iterable<File>): void {
    for (const file of files) {
      const id = randomId();
      const record = this.#record({ id, direction: 'out', name: file.name, size: file.size, mime: file.type });
      const outgoing = new OutgoingFile(id, file, record, TRANSFER.blockBytes, this.#clock);
      this.#outgoing.set(id, outgoing);
      this.#scheduler.add(outgoing);
    }
    this.#updateSending();
  }

  cancel(id: string): void {
    const outgoing = this.#outgoing.get(id);
    if (outgoing) this.#endOutgoing(outgoing, { status: 'cancelled' }, outgoing.started);
    this.#incoming.get(id)?.cancel();
  }

  /** Actual upload rate of files right now (bytes/second). */
  get uploadBytesPerSecond(): number {
    return this.#pacer.bytesPerSecond;
  }

  /** The call and the path, for Flow (PLAN.md §5.3): call changes as they happen, the rest per stats tick. */
  setFlowInputs(inputs: Partial<FlowSessionInputs>): void {
    this.#flow.setInputs(inputs);
  }

  /** File pacing as diagnostics show it. */
  get pacing(): PacingStatus {
    return this.#flow.status;
  }

  /** The last two minutes of pacing decisions (no addresses, names or file data). */
  get flowTrace(): FlowTrace {
    return this.#flow.trace;
  }

  dispose(): void {
    this.#disposer.dispose();
    for (const outgoing of [...this.#outgoing.values()]) this.#endOutgoing(outgoing, { status: 'cancelled' }, outgoing.started);
    for (const incoming of [...this.#incoming.values()]) incoming.cancel();
    this.#scheduler.close();
    this.#early.clear();
    this.#flow.dispose();
  }

  // ── Lanes ─────────────────────────────────────────────────────────────────

  #attach(lane: Lane): void {
    const { responder } = this.#flow;
    const reader = new BlockReader(
      (header, data) => this.#onBlock(header, data),
      (m) => responder.marked(m, lane.id),
    );
    const onMessage = ({ data }: MessageEvent) => {
      if (data instanceof ArrayBuffer) responder.received(data.byteLength);
      if (!reader.push(data)) lane.channel.close(); // Corrupt framing: drop the lane, its blocks get re-sent.
    };
    lane.channel.addEventListener('message', onMessage);
    lane.channel.addEventListener(
      'close',
      () => {
        this.#scheduler.removeLane(lane.id);
        this.#flow.laneClosed(lane.id);
      },
      { once: true },
    );
    this.#scheduler.addLane(lane);
  }

  // ── Receiving ─────────────────────────────────────────────────────────────

  #onOffer(offer: FileOffer): void {
    if (this.#incoming.has(offer.f) || this.#ended.has(offer.f)) return;
    const record = this.#record({ id: offer.f, direction: 'in', name: offer.name, size: offer.size, mime: offer.mime });
    const incoming = new IncomingFile(offer, record, {
      sink: this.#sinks(offer.f, offer.size, offer.mime),
      hasher: this.#hasher,
      reply: (m) => this.#send(m),
      onEnd: () => {
        this.#incoming.delete(offer.f);
        this.#ended.add(offer.f); // Late blocks (re-sent copies) are dropped, not held.
      },
    });
    this.#incoming.set(offer.f, incoming);
    const early = this.#early.take(offer.f);
    if (early[0]) record.update({ startedAt: early[0].at }); // Time from the first byte, not the offer.
    for (const { header, data } of early) incoming.accept(header, data);
  }

  #onBlock(header: BlockHeader, data: ArrayBuffer): void {
    const incoming = this.#incoming.get(header.f);
    if (incoming) return incoming.accept(header, data);
    if (!this.#ended.has(header.f)) this.#early.hold(header, data, this.#clock.now());
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  #onAck(id: string, index: number): void {
    const outgoing = this.#outgoing.get(id);
    if (!outgoing) return;
    this.#scheduler.acked(outgoing.ack(index));
    this.#flow.acked();
    this.#updateSending();
  }

  #onDone(id: string, ok: boolean): void {
    const outgoing = this.#outgoing.get(id);
    if (!outgoing) return;
    this.#endOutgoing(
      outgoing,
      ok ? { status: 'done', verified: true, bytes: outgoing.file.size } : { status: 'failed', verified: false, error: 'arrived-damaged' },
      false,
    );
  }

  #onCancelled(id: string): void {
    const outgoing = this.#outgoing.get(id);
    if (outgoing) this.#endOutgoing(outgoing, { status: 'cancelled' }, false);
    const incoming = this.#incoming.get(id);
    if (incoming) incoming.cancelledByPeer();
    else {
      this.#ended.add(id); // Cancelled before its offer arrived.
      this.#early.take(id);
    }
  }

  #checkStalls(): void {
    // No usable lane at all, for as long as an unanswered block would be given (FLOW-09).
    const noLane = this.#scheduler.noLaneMs > TRANSFER.stallTimeoutMs;
    for (const outgoing of [...this.#outgoing.values()]) {
      const stuck = (noLane && !outgoing.complete) || outgoing.stalledMs > TRANSFER.stallTimeoutMs;
      if (stuck) this.#endOutgoing(outgoing, { status: 'failed', error: 'no-response' }, true);
    }
  }

  /** Ends an outgoing file; `tell` lets the receiver know when it would otherwise keep waiting. */
  #endOutgoing(outgoing: OutgoingFile, patch: Parameters<TransferRecord['update']>[0], tell: boolean): void {
    if (!this.#outgoing.delete(outgoing.id)) return;
    if (tell) this.#send({ t: 'file-cancel', f: outgoing.id });
    outgoing.record.update(patch);
    this.#scheduler.remove(outgoing);
    this.#updateSending();
  }

  /** Flow probes fast only while blocks are queued or unacknowledged. */
  #updateSending(): void {
    this.#flow.sending([...this.#outgoing.values()].some((file) => !file.complete));
  }

  #send(message: TransferControl): void {
    this.deps.control.send(message);
  }

  #record(init: ConstructorParameters<typeof TransferRecord>[0]): TransferRecord {
    return new TransferRecord(init, (item) => this.events.emit('changed', item), this.#clock);
  }
}
