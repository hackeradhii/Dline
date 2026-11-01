import { parseMessage } from '../../../contracts/parse';
import type { Lane } from '../../../contracts/ports';
import { LaneTextSchema, type BlockHeader, type LaneMark } from '../../../contracts/transfer';

/** Fine pacing (PLAN.md §5.5): the size of each chunk, and the wait before it goes. */
export interface ChunkPacing {
  chunkBytes(laneChunkBytes: number): number;
  beforeChunk(bytes: number): Promise<void>;
}

/**
 * How a block travels on a lane (ordered and reliable): a JSON header, then exactly `n` bytes in
 * binary messages no larger than the lane allows. Both directions of the format live here (DRY).
 * Without `pacing` the block goes out at once; with it, chunk by chunk, each waiting its turn.
 * Either way, once the header is on a lane the whole block follows on that lane: the reader
 * would take anything else for a broken stream.
 */
export async function writeBlock(lane: Lane, header: BlockHeader, data: Uint8Array<ArrayBuffer>, pacing?: ChunkPacing): Promise<void> {
  lane.channel.send(JSON.stringify(header));
  for (let offset = 0; offset < data.byteLength; ) {
    const end = Math.min(data.byteLength, offset + (pacing?.chunkBytes(lane.chunkBytes) ?? lane.chunkBytes));
    if (pacing) await pacing.beforeChunk(end - offset);
    lane.channel.send(data.subarray(offset, end));
    offset = end;
  }
}

/** A drain marker, between blocks: everything sent before it on this lane arrives before it. */
export function writeMark(lane: Lane, m: number): void {
  lane.channel.send(JSON.stringify({ t: 'mark', m } satisfies LaneMark));
}

/** Reassembles one lane's messages into blocks, and reports drain markers found between them. */
export class BlockReader {
  #header: BlockHeader | null = null;
  #parts: ArrayBuffer[] = [];
  #received = 0;

  constructor(
    private readonly onBlock: (header: BlockHeader, data: ArrayBuffer) => void,
    private readonly onMark: (m: number) => void = () => undefined,
  ) {}

  /** Feeds one message. Returns false when the stream is corrupt; the lane should then be closed. */
  push(message: unknown): boolean {
    if (typeof message === 'string') {
      if (this.#header) return false;
      const text = parseMessage(LaneTextSchema, message);
      if (text?.t === 'mark') this.onMark(text.m);
      else this.#header = text;
      return text !== null;
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
