import type { ControlEvents, ControlMessage, ControlOf, ControlType } from '../../contracts/control';
import type { ControlChannel } from '../../contracts/ports';
import { Emitter, type Unsubscribe } from '../emitter';
import type { FakeClock } from './fake-clock';

/**
 * A deterministic model of one bottleneck, for flow-control simulations (tests only). Lanes hold
 * what was written to them (their send buffers) and feed one FIFO; the FIFO serves at the link's
 * capacity and holds at most `bufferMs` of backlog (lanes wait rather than drop, like SCTP behind a
 * deep cellular buffer); delivered packets arrive after a fixed delay. Each lane may only have a
 * window of bytes past its buffer, and the window grows by what it delivers (SCTP slow start, with
 * no loss to stop it). A reverse path carries replies with its own, possibly changing, delay.
 * Media can share the FIFO at a constant rate. Everything advances in 1 ms steps on a FakeClock.
 */
export interface BottleneckOptions {
  /** Capacity in bits/second at time t (ms). */
  capacityBps: (t: number) => number;
  /** Most backlog the bottleneck holds, in ms at the current capacity. */
  bufferMs: number;
  forwardDelayMs: number;
  /**
   * Extra forward delay at time t that no queue of ours causes (a cellular uplink's scheduling and
   * retransmissions). Packets still arrive in order, like a radio link's in-order delivery.
   */
  forwardJitterMs?: (t: number) => number;
  /** One-way delay of the reverse path at time t; a changing value models a reverse-path queue. */
  reverseDelayMs?: (t: number) => number;
  /** Media sharing the bottleneck, bits/second at time t. */
  mediaBps?: (t: number) => number;
  lanes: number;
  /** A lane's starting window: bytes past its buffer and not yet delivered (SCTP: 10 MTU). */
  laneWindowBytes?: number;
  /** Lane data arrived at the receiver. */
  onData?: (lane: number, bytes: number) => void;
}

const MTU = 1200;

interface Packet {
  bytes: number;
  lane: number | null;
  /** Runs when the packet arrives (on its last byte). */
  arrive: (() => void) | null;
}

/** One lane's send buffer in front of the bottleneck. */
export class SimLane {
  readonly #items: Array<{ bytes: number; arrive: (() => void) | null }> = [];
  bufferedBytes = 0;
  /** Bytes past the buffer and not yet delivered, and how many it may have. */
  inFlightBytes = 0;
  window: number;
  open = true;

  constructor(
    readonly id: number,
    window: number,
  ) {
    this.window = window;
  }

  /** Queues `bytes` (data, or a marker of a few bytes); `arrive` runs when the last of them arrives. */
  write(bytes: number, arrive: (() => void) | null = null): void {
    this.#items.push({ bytes, arrive });
    this.bufferedBytes += bytes;
  }

  /** Takes up to one MTU off the front of the buffer. */
  take(): Packet | null {
    const item = this.#items[0];
    if (!item) return null;
    const bytes = Math.min(MTU, item.bytes);
    item.bytes -= bytes;
    this.bufferedBytes -= bytes;
    if (item.bytes === 0) this.#items.shift();
    return { bytes, lane: this.id, arrive: item.bytes === 0 ? item.arrive : null };
  }
}

export class FakeBottleneck {
  readonly lanes: SimLane[];
  readonly #queue: Packet[] = [];
  #head = 0;
  #queuedBytes = 0;
  #headServed = 0;
  #mediaCarry = 0;
  #cursor = 0;
  readonly #forward: Array<{ at: number; packet: Packet }> = [];
  #forwardHead = 0;
  #lastForwardAt = 0;
  readonly #reverse: Array<{ at: number; arrive: () => void }> = [];
  #reverseHead = 0;
  #lastReverseAt = 0;
  /** Bytes delivered so far: lane data, and media. */
  readonly delivered = { data: 0, media: 0 };

  constructor(
    private readonly clock: FakeClock,
    private readonly options: BottleneckOptions,
  ) {
    this.lanes = Array.from({ length: options.lanes }, (_, id) => new SimLane(id, options.laneWindowBytes ?? 10 * MTU));
    clock.setInterval(() => this.#step(), 1);
  }

  /** The backlog right now, in ms at the current capacity: the queueing delay a packet would see. */
  get queueMs(): number {
    return (this.#queuedBytes * 8 * 1000) / this.options.capacityBps(this.clock.now());
  }

  /** A small message straight into the bottleneck (control traffic: its own nearly empty buffer). */
  sendForward(bytes: number, arrive: () => void): void {
    this.#enqueue({ bytes, lane: null, arrive });
  }

  /** A reply on the reverse path, in order. */
  sendReverse(arrive: () => void): void {
    const at = Math.max(this.#lastReverseAt, this.clock.now() + (this.options.reverseDelayMs?.(this.clock.now()) ?? this.options.forwardDelayMs));
    this.#lastReverseAt = at;
    this.#reverse.push({ at, arrive });
  }

  /** The lane closes: what is buffered is lost, what already left keeps going. */
  closeLane(id: number): void {
    const lane = this.lanes[id]!;
    lane.open = false;
    while (lane.take());
  }

  #enqueue(packet: Packet): void {
    this.#queue.push(packet);
    this.#queuedBytes += packet.bytes;
    if (packet.lane !== null) this.lanes[packet.lane]!.inFlightBytes += packet.bytes;
  }

  #step(): void {
    const t = this.clock.now();
    const perMs = this.options.capacityBps(t) / 8000;
    this.#addMedia(t);
    this.#feed(perMs);
    this.#serve(perMs, t);
    this.#arrive(t);
  }

  #addMedia(t: number): void {
    this.#mediaCarry += (this.options.mediaBps?.(t) ?? 0) / 8000;
    while (this.#mediaCarry >= MTU) {
      this.#mediaCarry -= MTU;
      this.#enqueue({ bytes: MTU, lane: null, arrive: () => (this.delivered.media += MTU) });
    }
  }

  /** Lanes feed the bottleneck in turn while it has room and their windows allow. */
  #feed(perMs: number): void {
    const room = this.options.bufferMs * perMs;
    for (let idle = 0; idle < this.lanes.length && this.#queuedBytes < room; ) {
      const lane = this.lanes[this.#cursor++ % this.lanes.length]!;
      const packet = lane.inFlightBytes < lane.window ? lane.take() : null;
      if (!packet) {
        idle++;
        continue;
      }
      idle = 0;
      const arrive = packet.arrive;
      this.#enqueue({
        ...packet,
        arrive: () => {
          this.delivered.data += packet.bytes;
          lane.window += packet.bytes;
          this.options.onData?.(lane.id, packet.bytes);
          arrive?.();
        },
      });
    }
  }

  #serve(perMs: number, t: number): void {
    let budget = perMs;
    while (budget > 0 && this.#head < this.#queue.length) {
      const packet = this.#queue[this.#head]!;
      const left = packet.bytes - this.#headServed;
      if (left > budget) {
        this.#headServed += budget;
        break;
      }
      budget -= left;
      this.#headServed = 0;
      this.#head++;
      this.#queuedBytes -= packet.bytes;
      const at = Math.max(this.#lastForwardAt, t + this.options.forwardDelayMs + (this.options.forwardJitterMs?.(t) ?? 0));
      this.#lastForwardAt = at;
      this.#forward.push({ at, packet });
    }
    if (this.#head > 4096) {
      this.#queue.splice(0, this.#head);
      this.#head = 0;
    }
  }

  #arrive(t: number): void {
    while (this.#forwardHead < this.#forward.length && this.#forward[this.#forwardHead]!.at <= t) {
      const { packet } = this.#forward[this.#forwardHead++]!;
      if (packet.lane !== null) this.lanes[packet.lane]!.inFlightBytes -= packet.bytes;
      packet.arrive?.();
    }
    while (this.#reverseHead < this.#reverse.length && this.#reverse[this.#reverseHead]!.at <= t) this.#reverse[this.#reverseHead++]!.arrive();
    if (this.#forwardHead > 4096) {
      this.#forward.splice(0, this.#forwardHead);
      this.#forwardHead = 0;
    }
    if (this.#reverseHead > 4096) {
      this.#reverse.splice(0, this.#reverseHead);
      this.#reverseHead = 0;
    }
  }
}

/** Carries one message across a path; `arrive` runs when it gets there. */
type Carry = (arrive: () => void) => void;

/** A `ctrl` endpoint whose messages cross the simulated path: the sender's forward, the receiver's back. */
export class SimControl implements ControlChannel {
  /** While false, sends fail, as on a channel that isn't open yet. */
  isOpen = true;
  readonly #handlers = new Emitter<ControlEvents>();
  /** Drops messages of these types on their way out (a peer that stops answering). */
  readonly mute = new Set<ControlType>();
  peer: SimControl | null = null;

  constructor(private readonly carry: Carry) {}

  /** Two endpoints: `a`'s messages travel by `forward`, `b`'s by `reverse`. */
  static linked(forward: Carry, reverse: Carry): { a: SimControl; b: SimControl } {
    const a = new SimControl(forward);
    const b = new SimControl(reverse);
    a.peer = b;
    b.peer = a;
    return { a, b };
  }

  /** Two endpoints: `a` sends through the bottleneck, `b` replies over the reverse path. */
  static pair(net: FakeBottleneck): { a: SimControl; b: SimControl } {
    return SimControl.linked(
      (arrive) => net.sendForward(64, arrive),
      (arrive) => net.sendReverse(arrive),
    );
  }

  send(message: ControlMessage): boolean {
    if (!this.isOpen) return false;
    if (this.mute.has(message.t)) return true;
    const peer = this.peer;
    this.carry(() => {
      if (peer) peer.#dispatch(message);
    });
    return true;
  }

  on<T extends ControlType>(type: T, handler: (message: ControlOf<T>) => void): Unsubscribe {
    return this.#handlers.on(type, handler);
  }

  #dispatch(message: ControlMessage): void {
    this.#handlers.emit(message.t, message);
  }
}
