import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';

/**
 * A tiny network emulator for two browser profiles on one machine (Windows has no `tc netem`).
 *
 * Every ICE host candidate is fronted by a UDP socket of ours (see shim.ts, which rewrites remote
 * candidates to point at the fronts). Packets between the two sides then cross one shared
 * bottleneck per direction: capacity, tail-drop queue, one-way delay and random loss. All of a
 * side's peer connections share that bottleneck, exactly like a real access link.
 */

export interface LinkProfile {
  /** Bottleneck capacity in bits per second. */
  rateBitsPerSecond: number;
  /** One-way propagation delay in ms (ping ≈ 2 × this + queueing). */
  delayMs: number;
  /** Random, non-congestion loss as a fraction (0.001 = 0.1 %). */
  loss: number;
  /** Bottleneck buffer as milliseconds of backlog at the link rate; beyond it packets are dropped. */
  queueMs: number;
}

export interface Scenario {
  name: string;
  link: LinkProfile;
}

export type Side = 'a' | 'b';

export interface LinkStats {
  packets: number;
  bytes: number;
  lost: number;
  dropped: number;
}

/** One direction of the bottleneck: FIFO, serialisation at the link rate, then fixed delay. */
class Link {
  readonly stats: LinkStats = { packets: 0, bytes: 0, lost: 0, dropped: 0 };
  readonly #queue: Array<{ at: number; send: () => void }> = [];
  #head = 0;
  #busyUntil = 0;
  #timer: NodeJS.Timeout | null = null;
  #spinning = false;

  constructor(private readonly profile: LinkProfile) {}

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
    this.#busyUntil = start + (size * 8 * 1000) / this.profile.rateBitsPerSecond;
    this.#queue.push({ at: this.#busyUntil + this.profile.delayMs, send });
    this.stats.packets++;
    this.stats.bytes += size;
    this.#arm();
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
    // Keyed by the sending side: links.a carries a → b.
    this.#links = { a: new Link(scenario.link), b: new Link(scenario.link) };
  }

  /** Our address standing in for `owner`'s candidate `address:port`. */
  async front(owner: Side, address: string, port: number): Promise<{ address: string; port: number }> {
    const front = await this.#front(owner, address, port);
    return { address, port: front.port };
  }

  stats(): Record<'aToB' | 'bToA', LinkStats> {
    return { aToB: { ...this.#links.a.stats }, bToA: { ...this.#links.b.stats } };
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

/** Paths worth beating. Ping figures are what the user saw between their two networks. */
export const SCENARIOS = {
  /** Same Wi-Fi, no impairment beyond our proxy. */
  lan: { name: 'LAN (proxy only)', link: { rateBitsPerSecond: 1000 * MBIT, delayMs: 1, loss: 0, queueMs: 50 } },
  /** Phone on 4G/5G ↔ home broadband: ~100 ms ping, a little random loss. */
  mobile: { name: 'Mobile ↔ broadband (100 ms, 0.1 % loss, 50 Mbit/s)', link: { rateBitsPerSecond: 50 * MBIT, delayMs: 50, loss: 0.001, queueMs: 60 } },
  /** Distant or congested path, like the 225 ms pings the user saw. */
  far: { name: 'Far path (220 ms, 0.2 % loss, 30 Mbit/s)', link: { rateBitsPerSecond: 30 * MBIT, delayMs: 110, loss: 0.002, queueMs: 80 } },
  /** Clean but long: no random loss, only the bottleneck queue drops. */
  clean: { name: 'Clean long path (100 ms, no random loss, 50 Mbit/s)', link: { rateBitsPerSecond: 50 * MBIT, delayMs: 50, loss: 0, queueMs: 60 } },
} as const satisfies Record<string, Scenario>;
