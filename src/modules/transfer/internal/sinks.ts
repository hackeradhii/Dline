import type { FileSink } from '../../../contracts/ports';
import { TRANSFER } from '../../../shared/config';

/** Picks where an incoming file is stored. Swappable strategy (open/closed). */
export type SinkFactory = (id: string, size: number, mime: string) => Promise<FileSink>;

/** Small files: blocks in memory, put in order and joined into a Blob at the end. */
export class MemorySink implements FileSink {
  #parts: Array<{ offset: number; data: ArrayBuffer }> = [];

  constructor(private readonly mime: string) {}

  async write(offset: number, data: ArrayBuffer): Promise<void> {
    this.#parts.push({ offset, data });
  }

  async close(): Promise<Blob> {
    const parts = this.#parts.sort((a, b) => a.offset - b.offset).map((p) => p.data);
    this.#parts = [];
    return new Blob(parts, { type: this.mime });
  }

  async abort(): Promise<void> {
    this.#parts = [];
  }
}

/** Large files: streamed to the browser's private file system, so a 1 GB video never sits in RAM. */
class OpfsSink implements FileSink {
  private constructor(
    private readonly dir: FileSystemDirectoryHandle,
    private readonly name: string,
    private readonly handle: FileSystemFileHandle,
    private readonly writable: FileSystemWritableFileStream,
    private readonly mime: string,
  ) {}

  static async create(id: string, mime: string): Promise<OpfsSink> {
    const dir = await incomingDirectory();
    const handle = await dir.getFileHandle(id, { create: true });
    return new OpfsSink(dir, id, handle, await handle.createWritable(), mime);
  }

  async write(offset: number, data: ArrayBuffer): Promise<void> {
    await this.writable.write({ type: 'write', position: offset, data });
  }

  async close(): Promise<Blob> {
    await this.writable.close();
    const file = await this.handle.getFile();
    // Disk-backed; re-typed so previews and saving get the right MIME type.
    return file.type === this.mime ? file : new Blob([file], { type: this.mime });
  }

  async abort(): Promise<void> {
    await this.writable.abort().catch(() => undefined);
    await this.dir.removeEntry(this.name).catch(() => undefined);
  }
}

function supportsOpfsWrites(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function' && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
}

async function incomingDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(TRANSFER.opfsDirectory, { create: true });
}

/** Default policy: RAM for small files, OPFS for big ones (falls back to RAM where OPFS can't write). */
export const defaultSinkFactory: SinkFactory = async (id, size, mime) => {
  if (size > TRANSFER.memoryLimitBytes && supportsOpfsWrites()) {
    try {
      return await OpfsSink.create(id, mime);
    } catch {
      // Quota or permission problem: fall through to memory.
    }
  }
  return new MemorySink(mime);
};

/** Received files are temporary: wipe leftovers from earlier sessions (PRD: nothing kept after close). */
export async function clearIncomingFiles(): Promise<void> {
  if (!supportsOpfsWrites()) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(TRANSFER.opfsDirectory, { recursive: true });
  } catch {
    // Nothing to clear.
  }
}
