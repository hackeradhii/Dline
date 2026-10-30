/** Tiny big-endian binary writer/reader for the compact link format. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class BinaryWriter {
  readonly #bytes: number[] = [];

  u8(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value >>> 8).u8(value);
  }

  u32(value: number): this {
    return this.u16(value >>> 16).u16(value);
  }

  bytes(value: Uint8Array): this {
    for (const b of value) this.#bytes.push(b);
    return this;
  }

  /** Length-prefixed (u8) UTF-8 string. */
  str(value: string): this {
    const encoded = encoder.encode(value);
    if (encoded.length > 255) throw new Error('String too long for compact encoding');
    return this.u8(encoded.length).bytes(encoded);
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

export class BinaryReader {
  #offset = 0;

  constructor(private readonly view: Uint8Array) {}

  get done(): boolean {
    return this.#offset >= this.view.length;
  }

  u8(): number {
    if (this.#offset >= this.view.length) throw new Error('Unexpected end of data');
    return this.view[this.#offset++]!;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u16() << 16) | this.u16()) >>> 0;
  }

  bytes(length: number): Uint8Array {
    if (this.#offset + length > this.view.length) throw new Error('Unexpected end of data');
    const out = this.view.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return out;
  }

  str(): string {
    return decoder.decode(this.bytes(this.u8()));
  }
}
