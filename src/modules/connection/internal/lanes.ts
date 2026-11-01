import type { LaneSignal } from '../../../contracts/lanes';
import type { ChannelFactory, ControlChannel, Lane, LaneSource, PeerFactory } from '../../../contracts/ports';
import { LANES } from '../../../shared/config';
import { Disposer, Emitter, type Unsubscribe } from '../../../shared/emitter';
import { systemClock, Timeout, type Clock } from '../../../shared/timer';
import { chunkSize } from './sctp';

/** Label of the bulk-data channel on every lane. */
export const BULK_LABEL = 'bulk';

/** Most extra lanes either side will run. */
const MAX_EXTRA = Math.max(...Object.values(LANES.extra));

/** How many extra lanes a path with this round-trip time needs. Unknown RTT counts as near. */
export function extraLanesFor(rttMs: number | null): number {
  return rttMs !== null && rttMs > LANES.nearRttMs ? LANES.extra.far : LANES.extra.near;
}

export interface LanePoolOptions {
  control: ControlChannel;
  /** The main connection. Lane 0 rides on it, so files flow before (and without) extra lanes. */
  main: ChannelFactory;
  peers: PeerFactory;
  /** STUN only, never TURN: an extra lane is a direct path or it doesn't exist. */
  iceServers: RTCIceServer[];
  /** The host opens lanes and the guest answers, so offers never collide. */
  initiator: boolean;
  clock?: Clock;
}

/** One extra lane: its own peer connection carrying one negotiated bulk channel. */
interface Extra {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  lane: Lane | null;
  /** Drops the lane if it does not open (or come back) in time. */
  timer: Timeout;
}

type Description = Extract<LaneSignal, { t: 'lane-sdp' }>['d'];
type Candidate = NonNullable<Extract<LaneSignal, { t: 'lane-ice' }>['c']>;

/**
 * The lanes between the two peers: lane 0 on the main connection plus extra peer connections,
 * negotiated in-band over `ctrl`. Every lane has its own congestion window, so file throughput on a
 * long or lossy path grows with the number of lanes instead of being capped by one window.
 * Lanes that fail, time out or lose their path are dropped; `grow()` replaces them.
 */
export class LanePool implements LaneSource {
  readonly events = new Emitter<{ lane: Lane; count: number }>();
  readonly #lanes: Lane[] = [];
  readonly #extras = new Map<number, Extra>();
  readonly #disposer = new Disposer();
  readonly #clock: Clock;
  #next = 1;
  #droppedAt = -Infinity;
  #baseRttMs: number | null = null;
  #closed = false;

  constructor(private readonly options: LanePoolOptions) {
    this.#clock = options.clock ?? systemClock;
    const { control, main } = options;
    const bulk = main.openChannel(BULK_LABEL, { negotiated: true, id: LANES.mainChannelId, ordered: true });
    const opened = () => this.#add({ id: 0, channel: bulk, chunkBytes: main.maxMessageSize });
    if (bulk.readyState === 'open') opened();
    else bulk.addEventListener('open', opened, { once: true });
    bulk.addEventListener('close', () => this.#remove(0));

    this.#disposer.add(control.on('lane-sdp', (m) => void this.#onDescription(m.n, m.d)));
    this.#disposer.add(control.on('lane-ice', (m) => m.c && this.#extras.get(m.n)?.pc.addIceCandidate(m.c).catch(() => undefined)));
    this.#disposer.add(control.on('lane-close', (m) => this.#drop(m.n, false)));
  }

  get lanes(): readonly Lane[] {
    return this.#lanes;
  }

  onLane(handler: (lane: Lane) => void): Unsubscribe {
    return this.events.on('lane', handler);
  }

  /**
   * Host only: size the pool for the path, given a fresh round-trip sample. Uses the lowest RTT seen,
   * i.e. the path's real distance: under load, queues inflate RTT on any path, even on a LAN.
   * Extra lanes only alongside a direct, connected main path: if that needed a relay, a direct lane
   * won't open either.
   */
  fit(rttMs: number | null, mainDirect: boolean): void {
    if (!mainDirect) return;
    if (rttMs !== null) this.#baseRttMs = Math.min(this.#baseRttMs ?? rttMs, rttMs);
    this.grow(extraLanesFor(this.#baseRttMs));
  }

  /** Host only: keep `count` extra lanes open or opening. Dropped lanes are replaced after a pause. */
  grow(count: number): void {
    if (!this.options.initiator || this.#closed) return;
    if (this.#clock.now() - this.#droppedAt < LANES.regrowAfterMs) return;
    const target = Math.min(count, MAX_EXTRA);
    while (this.#extras.size < target && this.#next <= LANES.maxNumber) void this.#offer(this.#next++);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#disposer.dispose();
    for (const n of [...this.#extras.keys()]) this.#drop(n, false);
    for (const lane of [...this.#lanes]) lane.channel.close();
  }

  async #offer(n: number): Promise<void> {
    const extra = this.#open(n);
    try {
      await extra.pc.setLocalDescription();
      this.#sendDescription(n, extra.pc);
    } catch {
      this.#drop(n, true);
    }
  }

  async #onDescription(n: number, description: Description): Promise<void> {
    const answering = description.type === 'offer' && !this.options.initiator;
    const extra = answering ? this.#accept(n) : this.#extras.get(n);
    if (!extra) return;
    try {
      await extra.pc.setRemoteDescription(description as RTCSessionDescriptionInit);
      if (!answering) return;
      await extra.pc.setLocalDescription();
      this.#sendDescription(n, extra.pc);
    } catch {
      this.#drop(n, true);
    }
  }

  /** Guest side: take a lane the host offered, up to our own cap. */
  #accept(n: number): Extra | null {
    if (this.#closed) return null;
    const existing = this.#extras.get(n);
    if (existing) return existing;
    if (this.#extras.size >= MAX_EXTRA) {
      this.#signal({ t: 'lane-close', n });
      return null;
    }
    return this.#open(n);
  }

  #open(n: number): Extra {
    const pc = this.options.peers.create({ iceServers: this.options.iceServers });
    const channel = pc.createDataChannel(BULK_LABEL, { negotiated: true, id: 0, ordered: true });
    channel.binaryType = 'arraybuffer';
    const extra: Extra = { pc, channel, lane: null, timer: new Timeout(this.#clock) };
    this.#extras.set(n, extra);
    this.#arm(n, extra, LANES.openTimeoutMs);
    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) this.#signal({ t: 'lane-ice', n, c: candidate.toJSON() as Candidate });
    });
    pc.addEventListener('connectionstatechange', () => this.#onState(n, extra));
    channel.addEventListener('open', () => {
      extra.timer.clear();
      extra.lane = { id: n, channel, chunkBytes: chunkSize(pc.sctp, LANES.chunkBytes) };
      this.#add(extra.lane);
    });
    channel.addEventListener('close', () => this.#drop(n, true));
    return extra;
  }

  /** A lane whose path breaks (e.g. a network switch) goes quickly, so its blocks are re-sent on others. */
  #onState(n: number, extra: Extra): void {
    const state = extra.pc.connectionState;
    if (state === 'failed' || state === 'closed') this.#drop(n, true);
    else if (state === 'disconnected') this.#arm(n, extra, LANES.disconnectGraceMs);
    else if (state === 'connected' && extra.lane) extra.timer.clear();
  }

  #arm(n: number, extra: Extra, ms: number): void {
    extra.timer.set(() => this.#drop(n, true), ms);
  }

  #drop(n: number, tell: boolean): void {
    const extra = this.#extras.get(n);
    if (!extra) return;
    this.#extras.delete(n);
    extra.timer.clear();
    if (tell) {
      this.#droppedAt = this.#clock.now();
      this.#signal({ t: 'lane-close', n });
    }
    this.#remove(n);
    extra.channel.close();
    extra.pc.close();
  }

  #add(lane: Lane): void {
    if (this.#closed) return;
    this.#lanes.push(lane);
    this.events.emit('lane', lane);
    this.events.emit('count', this.#lanes.length);
  }

  #remove(id: number): void {
    const index = this.#lanes.findIndex((lane) => lane.id === id);
    if (index < 0) return;
    this.#lanes.splice(index, 1);
    this.events.emit('count', this.#lanes.length);
  }

  #sendDescription(n: number, pc: RTCPeerConnection): void {
    const local = pc.localDescription;
    if (local) this.#signal({ t: 'lane-sdp', n, d: { type: local.type, sdp: local.sdp } });
  }

  #signal(message: LaneSignal): void {
    this.options.control.send(message);
  }
}
