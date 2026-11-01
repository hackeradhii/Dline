import { wireMs } from '../../../contracts/flow';
import type { ControlChannel } from '../../../contracts/ports';
import { FLOW } from '../../../shared/config';
import { Disposer, Emitter } from '../../../shared/emitter';
import { alwaysVisible, Timeout, type Clock, type Visibility } from '../../../shared/timer';

/** Whether the other device answers flow probes: not yet known, yes, or (so far) no. */
export type Capability = 'unknown' | 'supported' | 'unsupported';

/** One echo: what the path looked like for one probe. Times are on the sender's monotonic clock unless noted. */
export interface FlowSample {
  /** When the echo arrived. */
  at: number;
  /** When the probe left. */
  sentAt: number;
  rttMs: number;
  /** The receiver's arrival time minus the send time: one-way delay plus an unknown, constant clock offset. */
  owdMs: number;
  /** Bulk bytes the receiver had received on all lanes, and when (on the receiver's clock). */
  rxBytes: number;
  rxAt: number;
  /** Sent when nothing had gone to a lane for a while: it crossed an empty path. */
  idle: boolean;
}

/** Probes kept for matching echoes, at most: one per `minEchoGapMs` of `probeMaxAgeMs` (the peer answers no faster). */
const OUTSTANDING_MAX = Math.ceil(FLOW.probeMaxAgeMs / FLOW.minEchoGapMs);

/**
 * The sender's side of the feedback (PLAN.md §5.1). From the start it probes once a second until
 * the first echo, so whether the peer answers is known long before anyone picks a file:
 * `supported` on the first echo ever, `unsupported` if none came within `capabilityTimeoutMs` (the
 * slow probe carries on, and a later echo still upgrades). While sending to a peer that answers it
 * probes every `probeIntervalMs`, and also on acks once that interval has passed and, in a hidden
 * tab, on the echo of its latest probe: that keeps the cadence up when the tab's timers slow to
 * once a second.
 */
export class FlowProbe {
  readonly events = new Emitter<{ sample: FlowSample; capability: Capability }>();
  readonly #outstanding = new Map<number, { at: number; idle: boolean }>();
  readonly #disposer = new Disposer();
  #capability: Capability = 'unknown';
  #seq = 0;
  #lastEcho = -1;
  #sending = false;
  #lastProbeAt = -Infinity;
  readonly #timer: Timeout;
  /** An older peer never answers: when to stop waiting for its first echo. */
  readonly #deadline: Timeout;
  #closed = false;

  constructor(
    private readonly control: ControlChannel,
    private readonly clock: Clock,
    /** When a block last went to a lane. */
    private readonly lastWriteAt: () => number,
    private readonly visibility: Visibility = alwaysVisible,
  ) {
    this.#timer = new Timeout(clock);
    this.#deadline = new Timeout(clock);
    this.#disposer.add(control.on('flow-echo', (m) => this.#onEcho(m.s, m.ts, m.ra, m.rb)));
    this.#tick();
  }

  get capability(): Capability {
    return this.#capability;
  }

  /** Files are going out (blocks queued or unacknowledged), or no longer. */
  sending(on: boolean): void {
    if (on === this.#sending) return;
    this.#sending = on;
    this.#schedule();
  }

  /** An ack arrived: probe now if the interval has passed (timers may be throttled). */
  acked(): void {
    if (this.#fast() && this.clock.now() - this.#lastProbeAt >= FLOW.probeIntervalMs) this.probeNow();
  }

  /** Probes at once (a transfer is waiting on the answer, or a drain needs clean samples). */
  probeNow(): void {
    this.#tick();
  }

  dispose(): void {
    this.#closed = true;
    this.#disposer.dispose();
    this.#timer.clear();
    this.#deadline.clear();
  }

  #fast(): boolean {
    return this.#sending && this.#capability === 'supported';
  }

  #tick(): void {
    if (this.#closed) return;
    const now = this.clock.now();
    const ts = wireMs(now);
    const s = this.#seq++;
    if (this.control.send({ t: 'flow-probe', s, ts })) {
      this.#lastProbeAt = now;
      this.#outstanding.set(s, { at: ts, idle: !this.#sending && now - this.lastWriteAt() >= FLOW.idleCleanMs });
      this.#forgetOld(now);
      if (this.#capability === 'unknown' && !this.#deadline.pending) this.#deadline.set(() => this.#capabilityTimeout(), FLOW.capabilityTimeoutMs);
    }
    this.#schedule();
  }

  /** Forgets probes sent more than `probeMaxAgeMs` ago, oldest first (the map is in sending order). */
  #forgetOld(now: number): void {
    for (const [s, probe] of this.#outstanding) {
      if (now - probe.at <= FLOW.probeMaxAgeMs && this.#outstanding.size <= OUTSTANDING_MAX) return;
      this.#outstanding.delete(s);
    }
  }

  #schedule(): void {
    this.#timer.clear();
    if (this.#closed) return;
    this.#timer.set(() => this.#tick(), this.#fast() ? FLOW.probeIntervalMs : FLOW.legacyProbeIntervalMs);
  }

  #capabilityTimeout(): void {
    if (this.#capability !== 'unknown') return;
    this.#capability = 'unsupported';
    this.events.emit('capability', 'unsupported');
  }

  #onEcho(s: number, ts: number, ra: number, rb: number): void {
    const probe = this.#outstanding.get(s);
    if (!probe || s <= this.#lastEcho || probe.at !== ts) return; // Stale, a duplicate, or not one of ours.
    this.#lastEcho = s;
    for (const k of [...this.#outstanding.keys()]) if (k <= s) this.#outstanding.delete(k);
    const now = this.clock.now();
    if (this.#capability !== 'supported') {
      this.#capability = 'supported';
      this.events.emit('capability', 'supported');
      this.#schedule();
    }
    this.events.emit('sample', { at: now, sentAt: ts, rttMs: now - ts, owdMs: ra - ts, rxBytes: rb, rxAt: ra, idle: probe.idle });
    // A hidden tab's timers fire about once a second, but the network's events don't wait. While
    // sending, the echo of the latest probe brings the next one, so the cadence, and with it the
    // pacer's wake-ups, keeps up with the round trip (PLAN.md §5.5).
    const latest = s === this.#seq - 1;
    if (latest && this.#fast() && !this.visibility.isVisible() && now - this.#lastProbeAt >= FLOW.minEchoGapMs) this.probeNow();
  }
}
