import type { BlockHeader } from '../../../contracts/transfer';
import { TRANSFER } from '../../../shared/config';

interface Held {
  header: BlockHeader;
  data: ArrayBuffer;
  /** When it arrived (ms timestamp). */
  at: number;
}

/**
 * A file's offer travels on `ctrl` and its blocks on other channels, so a block can arrive first.
 * Such blocks wait here (bounded) until the offer lands, instead of costing a round trip per file.
 * A block dropped because this is full is never acknowledged, so the sender sends it again.
 */
export class EarlyBlocks {
  readonly #byFile = new Map<string, Held[]>();
  #bytes = 0;

  /** Returns false when the buffer is full (the block is dropped). */
  hold(header: BlockHeader, data: ArrayBuffer, at: number): boolean {
    if (this.#bytes + data.byteLength > TRANSFER.earlyBlocksLimitBytes) return false;
    const held = this.#byFile.get(header.f) ?? [];
    held.push({ header, data, at });
    this.#byFile.set(header.f, held);
    this.#bytes += data.byteLength;
    return true;
  }

  take(fileId: string): Held[] {
    const held = this.#byFile.get(fileId) ?? [];
    this.#byFile.delete(fileId);
    for (const { data } of held) this.#bytes -= data.byteLength;
    return held;
  }

  clear(): void {
    this.#byFile.clear();
    this.#bytes = 0;
  }
}
