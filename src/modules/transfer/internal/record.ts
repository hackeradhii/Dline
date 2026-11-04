import { isFinished, type FinishedStatus, type TransferDirection } from '../../../contracts/transfer';
import { TRANSFER } from '../../../shared/config';
import { systemClock, type Clock } from '../../../shared/timer';
import { SpeedMeter } from './flow';

type TransferStatus = 'queued' | 'transferring' | 'verifying' | FinishedStatus;

/** Why a file failed; the app words it (`TRANSFER_ERROR_COPY`). */
export type TransferError =
  /** Sending: the file could not be read (e.g. deleted after it was picked). */
  | 'unreadable'
  /** Sending: the receiver's check found it damaged. */
  | 'arrived-damaged'
  /** Sending: nothing acknowledged for too long, or no lane to send on. */
  | 'no-response'
  /** Receiving: a block that does not fit the file. */
  | 'bad-block'
  /** Receiving: the SHA-256 did not match. */
  | 'damaged'
  /** Receiving: the file could not be written. */
  | 'unsaved';

export interface TransferItem {
  id: string;
  direction: TransferDirection;
  name: string;
  size: number;
  mime: string;
  bytes: number;
  bytesPerSecond: number;
  etaMs: number;
  status: TransferStatus;
  /** SHA-256 matched (true), mismatched (false) or not checked yet (null). */
  verified: boolean | null;
  /** The received file (incoming, once complete). */
  file: Blob | null;
  error: TransferError | null;
  /** When bytes started flowing (ms timestamp), or null while queued. */
  startedAt: number | null;
  /** Real time taken so far; once finished, the total from first byte to verified. */
  elapsedMs: number;
}

/** Progress bookkeeping shared by sender and receiver (DRY): speed, ETA, throttled change events. */
export class TransferRecord {
  readonly #item: TransferItem;
  readonly #meter: SpeedMeter;
  #lastEmit = 0;

  constructor(
    init: Pick<TransferItem, 'id' | 'direction' | 'name' | 'size' | 'mime'> & { status?: TransferStatus },
    private readonly emit: (item: TransferItem) => void,
    private readonly clock: Clock = systemClock,
  ) {
    this.#item = { bytes: 0, bytesPerSecond: 0, etaMs: Infinity, verified: null, file: null, error: null, status: 'queued', startedAt: null, elapsedMs: 0, ...init };
    this.#meter = new SpeedMeter(clock);
    this.emit({ ...this.#item });
  }

  get item(): Readonly<TransferItem> {
    return this.#item;
  }

  get finished(): boolean {
    return isFinished(this.#item.status);
  }

  progress(bytes: number): void {
    this.#item.bytes = bytes;
    this.#meter.record(bytes);
    this.#item.bytesPerSecond = this.#meter.bytesPerSecond;
    this.#item.etaMs = this.#meter.etaMs(this.#item.size - bytes);
    this.#tick();
    const now = this.clock.now();
    if (now - this.#lastEmit >= TRANSFER.progressEmitMs || bytes === this.#item.size) {
      this.#lastEmit = now;
      this.emit({ ...this.#item });
    }
  }

  update(patch: Partial<Omit<TransferItem, 'id' | 'direction'>>): void {
    if (this.finished) return;
    Object.assign(this.#item, patch);
    if (patch.status === 'transferring' && this.#item.startedAt === null) this.#item.startedAt = this.clock.now();
    this.#tick();
    if (this.finished) this.#item.etaMs = 0;
    this.emit({ ...this.#item });
  }

  #tick(): void {
    if (this.#item.startedAt !== null) this.#item.elapsedMs = this.clock.now() - this.#item.startedAt;
  }
}
