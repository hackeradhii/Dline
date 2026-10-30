import { parseMessage } from '../../../contracts/parse';
import type { Lane } from '../../../contracts/ports';
import { BlockHeaderSchema, type BlockHeader } from '../../../contracts/transfer';

/**
 * How a block travels on a lane (ordered and reliable): a JSON header, then exactly `n` bytes in
 * binary messages no larger than the lane allows. Both directions of the format live here (DRY).
 */
export function writeBlock(lane: Lane, header: BlockHeader, data: Uint8Array<ArrayBuffer>): void {
  lane.channel.send(JSON.stringify(header));
  for (let offset = 0; offset < data.byteLength; offset += lane.chunkBytes) {
    lane.channel.send(data.subarray(offset, offset + lane.chunkBytes));
  }
}

/** Reassembles one lane's messages into blocks. */
export class BlockReader {
  #header: BlockHeader | null = null;
  #parts: ArrayBuffer[] = [];
  #received = 0;

  constructor(private readonly onBlock: (header: BlockHeader, data: ArrayBuffer) => void) {}

  /** Feeds one message. Returns false when the stream is corrupt; the lane should then be closed. */
  push(message: unknown): boolean {
    if (typeof message === 'string') {
      if (this.#header) return false;
      this.#header = parseMessage(BlockHeaderSchema, message);
      return this.#header !== null;
    }
    const header = this.#header;
    if (!header || !(message instanceof ArrayBuffer)) return false;
    this.#parts.push(message);
    this.#received += message.byteLength;
    if (this.#received > header.n) return false;
    if (this.#received === header.n) this.#complete(header);
    return true;
  }

  #complete(header: BlockHeader): void {
    const parts = this.#parts;
    this.#header = null;
    this.#parts = [];
    this.#received = 0;
    this.onBlock(header, parts.length === 1 ? parts[0]! : join(parts, header.n));
  }
}

function join(parts: ArrayBuffer[], length: number): ArrayBuffer {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return out.buffer;
}
