import type { BlockHasher, FileSink } from '../../../contracts/ports';
import type { BlockHeader, FileOffer, TransferControl } from '../../../contracts/transfer';
import { SerialQueue } from '../../../shared/async';
import type { TransferError, TransferRecord } from './record';

type Patch = Parameters<TransferRecord['update']>[0];

interface IncomingDeps {
  sink: Promise<FileSink>;
  hasher: BlockHasher;
  reply: (message: TransferControl) => void;
  /** Called once, when the file is done, failed or cancelled. */
  onEnd: () => void;
}

/**
 * One file being received. Each block is checked against its own SHA-256 as soon as it lands
 * (hashing runs natively and in parallel), then stored at its offset and acknowledged. The file is
 * complete when every block is in; blocks may arrive in any order and over any lane.
 */
export class IncomingFile {
  readonly blockCount: number;
  readonly #have: Uint8Array;
  readonly #writes = new SerialQueue();
  #stored = 0;
  #bytes = 0;

  constructor(
    readonly offer: FileOffer,
    readonly record: TransferRecord,
    private readonly deps: IncomingDeps,
  ) {
    this.blockCount = Math.ceil(offer.size / offer.block);
    this.#have = new Uint8Array(this.blockCount);
    deps.sink.catch(() => undefined); // Surfaces through the first write.
    record.update({ status: 'transferring' });
    if (this.blockCount === 0) this.#run(() => this.#complete());
  }

  get finished(): boolean {
    return this.record.finished;
  }

  accept(header: BlockHeader, data: ArrayBuffer): void {
    if (this.finished) return;
    if (header.i >= this.blockCount || data.byteLength !== this.#length(header.i)) return void this.fail('bad-block');
    if (this.#have[header.i]) return this.#ack(header.i); // Re-sent after a lane dropped; already stored.
    const digest = this.deps.hasher.digest(data);
    digest.catch(() => undefined);
    this.#run(async () => {
      if (this.finished || this.#have[header.i]) return;
      if ((await digest) !== header.h) return this.#damaged();
      await (await this.deps.sink).write(header.i * this.offer.block, data);
      this.#have[header.i] = 1;
      this.#stored++;
      this.#bytes += data.byteLength;
      this.record.progress(this.#bytes);
      this.#ack(header.i);
      if (this.#stored === this.blockCount) await this.#complete();
    });
  }

  /** We cancelled. */
  cancel(): void {
    this.#abort({ status: 'cancelled' }, { t: 'file-cancel', f: this.offer.f });
  }

  /** They cancelled. */
  cancelledByPeer(): void {
    this.#abort({ status: 'cancelled' }, null);
  }

  fail(reason: TransferError): void {
    this.#abort({ status: 'failed', error: reason }, { t: 'file-cancel', f: this.offer.f });
  }

  async #complete(): Promise<void> {
    const file = await (await this.deps.sink).close();
    if (this.finished) return;
    this.deps.reply({ t: 'file-done', f: this.offer.f, ok: true });
    this.#end({ status: 'done', verified: true, file });
  }

  #damaged(): void {
    this.#abort({ status: 'failed', verified: false, error: 'damaged' }, { t: 'file-done', f: this.offer.f, ok: false });
  }

  #abort(patch: Patch, tell: TransferControl | null): void {
    if (this.finished) return;
    if (tell) this.deps.reply(tell);
    this.#end(patch);
    void this.deps.sink.then((sink) => sink.abort()).catch(() => undefined);
  }

  #end(patch: Patch): void {
    this.record.update(patch);
    this.deps.onEnd();
  }

  #ack(index: number): void {
    this.deps.reply({ t: 'file-ack', f: this.offer.f, i: index });
  }

  #run(task: () => Promise<void>): void {
    this.#writes.run(task).catch(() => this.fail('unsaved'));
  }

  #length(index: number): number {
    return Math.min(this.offer.block, this.offer.size - index * this.offer.block);
  }
}
