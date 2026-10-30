import type { ChannelFactory, Lane, LaneSource } from '../../contracts/ports';
import { Emitter, type Unsubscribe } from '../emitter';

/** An in-memory RTCDataChannel stand-in: delivers messages to its twin asynchronously, in order. */
export class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'arraybuffer';
  twin: FakeDataChannel | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  /** Test hook to tamper with binary data in flight. */
  tamper: ((bytes: Uint8Array) => void) | null = null;
  /** One-way delay; 0 delivers on the next microtask. Order is kept either way. */
  latencyMs = 0;

  constructor(readonly label: string) {
    super();
  }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError');
    let payload: string | ArrayBuffer;
    if (typeof data === 'string') payload = data;
    else {
      const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      const copy = view.slice();
      this.tamper?.(copy);
      payload = copy.buffer;
    }
    // Like the browser: queued bytes count until they leave, and draining past the threshold says so.
    const size = typeof payload === 'string' ? payload.length : payload.byteLength;
    this.bufferedAmount += size;
    const deliver = () => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= size;
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatchEvent(new Event('bufferedamountlow'));
      this.twin?.deliver(payload);
    };
    if (this.latencyMs > 0) setTimeout(deliver, this.latencyMs);
    else queueMicrotask(deliver);
  }

  deliver(data: string | ArrayBuffer): void {
    if (this.readyState !== 'open') return;
    const event = new MessageEvent('message', { data });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    this.dispatchEvent(new Event('close'));
    const twin = this.twin;
    queueMicrotask(() => twin?.close());
  }
}

/** Two twinned channels; open on the next microtask unless `open` is false. */
export function fakeChannelPair(label: string, open = true): [FakeDataChannel, FakeDataChannel] {
  const a = new FakeDataChannel(label);
  const b = new FakeDataChannel(label);
  a.twin = b;
  b.twin = a;
  if (open) {
    queueMicrotask(() => {
      a.open();
      b.open();
    });
  }
  return [a, b];
}

export const asChannel = (channel: FakeDataChannel): RTCDataChannel => channel as unknown as RTCDataChannel;

/** A LaneSource that tests fill by hand. */
export class FakeLaneSource implements LaneSource {
  readonly #added = new Emitter<{ lane: Lane }>();
  readonly lanes: Lane[] = [];

  add(lane: Lane): void {
    this.lanes.push(lane);
    this.#added.emit('lane', lane);
  }

  onLane(handler: (lane: Lane) => void): Unsubscribe {
    return this.#added.on('lane', handler);
  }
}

/** `count` lanes joining two sides, already open. Channels are returned so tests can break them. */
export async function fakeLanes(
  count: number,
  chunkBytes: number,
  tamper: FakeDataChannel['tamper'] = null,
): Promise<{ a: FakeLaneSource; b: FakeLaneSource; channels: Array<[FakeDataChannel, FakeDataChannel]> }> {
  const a = new FakeLaneSource();
  const b = new FakeLaneSource();
  const channels = Array.from({ length: count }, () => fakeChannelPair('bulk'));
  await Promise.resolve(); // Let them open.
  channels.forEach(([mine, theirs], id) => {
    mine.tamper = tamper;
    a.add({ id, channel: asChannel(mine), chunkBytes });
    b.add({ id, channel: asChannel(theirs), chunkBytes });
  });
  return { a, b, channels };
}

/** A ChannelFactory whose channels twin with the other side's channel of the same negotiated id. */
export function fakeChannelFactories(maxMessageSize = 64 * 1024): { a: ChannelFactory; b: ChannelFactory } {
  const waiting = new Map<number, FakeDataChannel>();
  const make = (): ChannelFactory => ({
    maxMessageSize,
    openChannel(label, init) {
      const channel = new FakeDataChannel(label);
      const id = init?.id ?? -1;
      const other = waiting.get(id);
      if (other) {
        waiting.delete(id);
        channel.twin = other;
        other.twin = channel;
        queueMicrotask(() => {
          other.open();
          channel.open();
        });
      } else waiting.set(id, channel);
      return asChannel(channel);
    },
  });
  return { a: make(), b: make() };
}
