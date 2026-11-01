import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';
import { seeded } from './random';

/**
 * A tiny network emulator for two browser profiles on one machine (Windows has no `tc netem`).
 *
 * Every ICE host candidate is fronted by a UDP socket of ours (see shim.ts, which rewrites remote
 * candidates to point at the fronts). Packets between the two sides then cross one shared
 * bottleneck per direction: capacity, tail-drop queue, one-way delay and random loss. All of a
 * side's peer connections share that bottleneck, exactly like a real access link. The two
 * directions can differ, like a phone's narrow uplink and the laptop's broadband.
 */

/** A capacity that drifts: a random walk, seeded so every run sees the same drift. */
export interface RateSchedule {
  /** How often the capacity takes a step. */
  periodMs: number;
  minBitsPerSecond: number;
  maxBitsPerSecond: number;
  seed: number;
}

export interface LinkProfile {
  /** Bottleneck capacity in bits per second (where a `rateSchedule` starts). */
  rateBitsPerSecond: number;
  /** One-way propagation delay in ms (ping ≈ 2 × this + queueing). */
  delayMs: number;
  /** Random, non-congestion loss as a fraction (0.001 = 0.1 %). */
  loss: number;
  /** Bottleneck buffer as milliseconds of backlog at the link rate; beyond it packets are dropped. */
  queueMs: number;
  /** Optional drifting capacity, like a cellular link. */
  rateSchedule?: RateSchedule;
}

export interface Scenario {
  name: string;
  /** a's uplink, carrying a → b. */
  aToB: LinkProfile;
  /** b's uplink, carrying b → a. */
  bToA: LinkProfile;
}

export type Side = 'a' | 'b';
export type Direction = 'aToB' | 'bToA';
export const DIRECTIONS: readonly Direction[] = ['aToB', 'bToA'];
const SENDER: Record<Direction, Side> = { aToB: 'a', bToA: 'b' };

/** The same link both ways. */
export const symmetric = (name: string, link: LinkProfile): Scenario => ({ name, aToB: link, bToA: link });

export interface LinkStats {
  packets: number;
  bytes: number;
  lost: number;
  dropped: number;
}

/** Each step of a drifting capacity moves it by at most this share of its range. */
const DRIFT_STEP = 0.1;

/** A link's capacity over time: fixed, or a seeded random walk inside its range. */
class Capacity {
  readonly #since = performance.now();
  readonly #random: () => number;
  #steps = 0;
  #bitsPerSecond: number;

  constructor(private readonly profile: LinkProfile) {
    this.#bitsPerSecond = profile.rateBitsPerSecond;
    this.#random = seeded(profile.rateSchedule?.seed ?? 0);
  }

  at(now: number): number {
    const drift = this.profile.rateSchedule;
    if (!drift) return this.#bitsPerSecond;
    const range = drift.maxBitsPerSecond - drift.minBitsPerSecond;
    for (const due = Math.floor((now - this.#since) / drift.periodMs); this.#steps < due; this.#steps++) {
      const next = this.#bitsPerSecond + (this.#random() * 2 - 1) * DRIFT_STEP * range;
      this.#bitsPerSecond = Math.min(drift.maxBitsPerSecond, Math.max(drift.minBitsPerSecond, next));
    }
    return this.#bitsPerSecond;
  }
}

/** One direction of the bottleneck: FIFO, serialisation at the link rate, then fixed delay. */
class Link {
  readonly stats: LinkStats = { packets: 0, bytes: 0, lost: 0, dropped: 0 };
  readonly #queue: Array<{ at: number; send: () => void }> = [];
  readonly #capacity: Capacity;
  #head = 0;
  #busyUntil = 0;
  #timer: NodeJS.Timeout | null = null;
  #spinning = false;

  constructor(private readonly profile: LinkProfile) {
    this.#capacity = new Capacity(profile);
  }

  push(size: number, send: () => void): void {
    if (Math.random() < this.profile.loss) {
      this.stats.lost++;
      return;
    }
    const now = performance.now();
    const start = Math.max(now, this.#busyUntil);
    if (start - now > this.profile.queueMs) {
      this.stats.dropped++;
      return;
    }
    this.#busyUntil = start + (size * 8 * 1000) / this.#capacity.at(now);
    this.#queue.push({ at: this.#busyUntil + this.profile.delayMs, send });
    this.stats.packets++;
    this.stats.bytes += size;
    this.#arm();
  }

  /** How long a packet arriving now would wait for the link: the queueing delay, in ms. */
  backlogMs(): number {
    return Math.max(0, this.#busyUntil - performance.now());
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#queue.length = 0;
    this.#head = 0;
  }

  // Windows timers tick every ~15.6 ms, so sleep with setTimeout only when the next packet is far
  // away, then spin on setImmediate for sub-millisecond delivery (I/O still runs between spins).
  #arm(): void {
    if (this.#timer || this.#spinning) return;
    const next = this.#queue[this.#head];
    if (!next) return;
    const wait = next.at - performance.now();
    if (wait > 20) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#arm();
      }, wait - 17);
    } else {
      this.#spinning = true;
      setImmediate(() => this.#flush());
    }
  }

  #flush(): void {
    this.#spinning = false;
    const now = performance.now();
    while (this.#head < this.#queue.length && this.#queue[this.#head]!.at <= now) this.#queue[this.#head++]!.send();
    if (this.#head > 4096) {
      this.#queue.splice(0, this.#head);
      this.#head = 0;
    }
    this.#arm();
  }
}

interface Front {
  owner: Side;
  real: { address: string; port: number };
  socket: dgram.Socket;
  port: number;
}

export class Netem {
  readonly #fronts = new Map<string, Promise<Front>>();
  readonly #links: Record<Side, Link>;

  constructor(readonly scenario: Scenario) {
    // Keyed by the sending side: links.a is a's uplink, carrying a → b.
    this.#links = { a: new Link(scenario.aToB), b: new Link(scenario.bToA) };
  }

  /** Our address standing in for `owner`'s candidate `address:port`. */
  async front(owner: Side, address: string, port: number): Promise<{ address: string; port: number }> {
    const front = await this.#front(owner, address, port);
    return { address, port: front.port };
  }

  stats(): Record<Direction, LinkStats> {
    return { aToB: { ...this.#links.a.stats }, bToA: { ...this.#links.b.stats } };
  }

  /** The bottleneck's backlog in one direction right now, in ms: the ground truth for queueing delay. */
  queueDelayMs(direction: Direction): number {
    return this.#links[SENDER[direction]].backlogMs();
  }

  async close(): Promise<void> {
    this.#links.a.close();
    this.#links.b.close();
    const fronts = await Promise.all(this.#fronts.values());
    await Promise.all(fronts.map((f) => new Promise<void>((resolve) => f.socket.close(() => resolve()))));
    this.#fronts.clear();
  }

  #front(owner: Side, address: string, port: number): Promise<Front> {
    const key = `${address}:${port}`;
    let front = this.#fronts.get(key);
    if (!front) {
      front = this.#open(owner, address, port);
      this.#fronts.set(key, front);
    }
    return front;
  }

  async #open(owner: Side, address: string, port: number): Promise<Front> {
    const socket = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 << 20, sendBufferSize: 8 << 20 });
    // Bind on the candidate's own interface so delivery stays local under Windows' strong host model.
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, address, () => resolve());
    });
    const front: Front = { owner, real: { address, port }, socket, port: socket.address().port };
    socket.on('message', (packet, from) => void this.#forward(front, packet, from));
    return front;
  }

  /** `packet` arrived at `to`'s front from the other side's real socket `from`. */
  async #forward(to: Front, packet: Buffer, from: dgram.RemoteInfo): Promise<void> {
    const sender = await this.#front(to.owner === 'a' ? 'b' : 'a', from.address, from.port);
    this.#links[sender.owner].push(packet.byteLength, () => sender.socket.send(packet, to.real.port, to.real.address));
  }
}

const MBIT = 1_000_000;

/** A phone's cellular uplink as measured on Jio 5G: narrow, with a deep buffer that queues instead of dropping. */
const CELL_UPLINK: LinkProfile = { rateBitsPerSecond: 9 * MBIT, delayMs: 20, loss: 0, queueMs: 3000 };
/** The laptop's broadband, receiving from the phone. */
const BROADBAND_DOWN: LinkProfile = { rateBitsPerSecond: 100 * MBIT, delayMs: 20, loss: 0, queueMs: 100 };

/** Paths worth beating. Ping figures are what the user saw between their two networks. */
export const SCENARIOS = {
  /** Same Wi-Fi, no impairment beyond our proxy. */
  lan: symmetric('LAN (proxy only)', { rateBitsPerSecond: 1000 * MBIT, delayMs: 1, loss: 0, queueMs: 50 }),
  /** Phone on 4G/5G ↔ home broadband: ~100 ms ping, a little random loss. */
  mobile: symmetric('Mobile ↔ broadband (100 ms, 0.1 % loss, 50 Mbit/s)', { rateBitsPerSecond: 50 * MBIT, delayMs: 50, loss: 0.001, queueMs: 60 }),
  /** Distant or congested path, like the 225 ms pings the user saw. */
  far: symmetric('Far path (220 ms, 0.2 % loss, 30 Mbit/s)', { rateBitsPerSecond: 30 * MBIT, delayMs: 110, loss: 0.002, queueMs: 80 }),
  /** Clean but long: no random loss, only the bottleneck queue drops. */
  clean: symmetric('Clean long path (100 ms, no random loss, 50 Mbit/s)', { rateBitsPerSecond: 50 * MBIT, delayMs: 50, loss: 0, queueMs: 60 }),
  /** The phone (a) sends through its own uplink, as in the field test. */
  'cell-up': { name: 'Phone → laptop over a 9 Mbit/s uplink with a 3 s buffer', aToB: CELL_UPLINK, bToA: BROADBAND_DOWN },
  /** The laptop (a) sends; the phone's narrow uplink carries the acks and its own video. */
  'cell-down': {
    name: 'Laptop (30 Mbit/s) → phone with a 9 Mbit/s, 3 s uplink',
    aToB: { rateBitsPerSecond: 30 * MBIT, delayMs: 15, loss: 0, queueMs: 200 },
    bToA: CELL_UPLINK,
  },
  /** cell-up with the uplink drifting, like a phone on the move. */
  'cell-var': {
    name: 'Phone → laptop over an uplink drifting 5–12 Mbit/s (3 s buffer)',
    aToB: { ...CELL_UPLINK, rateSchedule: { periodMs: 250, minBitsPerSecond: 5 * MBIT, maxBitsPerSecond: 12 * MBIT, seed: 1 } },
    bToA: BROADBAND_DOWN,
  },
} as const satisfies Record<string, Scenario>;
