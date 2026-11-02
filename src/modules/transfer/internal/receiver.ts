import type { BlockHasher } from '../../../contracts/ports';
import type { BlockHeader, FileOffer, TransferControl } from '../../../contracts/transfer';
import type { Clock } from '../../../shared/timer';
import { EarlyBlocks } from './early-blocks';
import { IncomingFile } from './incoming';
import type { TransferRecord } from './record';
import type { SinkFactory } from './sinks';

interface ReceiverDeps {
  sinks: SinkFactory;
  hasher: BlockHasher;
  clock: Clock;
  /** Acks and results back to the sender, over `ctrl`. */
  reply: (message: TransferControl) => void;
  /** A new item in the transfer list. */
  record: (init: ConstructorParameters<typeof TransferRecord>[0]) => TransferRecord;
}

/**
 * The receiving side: any number of incoming files at once. Blocks may beat their offer (offers go
 * just before the first block, on another path), so they are held until it arrives; blocks for a
 * file that already ended (re-sent copies) are dropped.
 */
export class Receiver {
  readonly #incoming = new Map<string, IncomingFile>();
  /** Incoming files that ended (or were cancelled before their offer arrived). */
  readonly #ended = new Set<string>();
  readonly #early = new EarlyBlocks();

  constructor(private readonly deps: ReceiverDeps) {}

  offer(offer: FileOffer): void {
    if (this.#incoming.has(offer.f) || this.#ended.has(offer.f)) return;
    const record = this.deps.record({ id: offer.f, direction: 'in', name: offer.name, size: offer.size, mime: offer.mime });
    const incoming = new IncomingFile(offer, record, {
      sink: this.deps.sinks(offer.f, offer.size, offer.mime),
      hasher: this.deps.hasher,
      reply: this.deps.reply,
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

  block(header: BlockHeader, data: ArrayBuffer): void {
    const incoming = this.#incoming.get(header.f);
    if (incoming) return incoming.accept(header, data);
    if (!this.#ended.has(header.f)) this.#early.hold(header, data, this.deps.clock.now());
  }

  /** We cancel an incoming file (no-op for any other id). */
  cancel(id: string): void {
    this.#incoming.get(id)?.cancel();
  }

  /** The sender cancelled `id`, possibly before its offer arrived. */
  cancelledByPeer(id: string): void {
    const incoming = this.#incoming.get(id);
    if (incoming) return incoming.cancelledByPeer();
    this.#ended.add(id);
    this.#early.take(id);
  }

  dispose(): void {
    for (const incoming of [...this.#incoming.values()]) incoming.cancel();
    this.#early.clear();
  }
}
