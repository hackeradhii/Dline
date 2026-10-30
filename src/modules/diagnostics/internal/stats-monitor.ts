import type { StatsSource } from '../../../contracts/ports';
import { STATS } from '../../../shared/config';
import { Emitter } from '../../../shared/emitter';
import { systemClock, type Clock } from '../../../shared/timer';
import { parseStats, type StatsSample } from './stats-parser';

export interface ConnectionSnapshot extends StatsSample {
  sendBps: number;
  receiveBps: number;
  lossPercent: number | null;
  /** Cumulative bytes that went through a TURN relay this session. 0 = fully peer-to-peer. */
  relayedBytes: number;
}

/** Polls `getStats()` once a second and turns counters into rates. */
export class StatsMonitor {
  readonly events = new Emitter<{ snapshot: ConnectionSnapshot }>();
  #previous: StatsSample | null = null;
  #latest: ConnectionSnapshot | null = null;
  #relayedBytes = 0;
  #handle: unknown = null;
  #busy = false;

  constructor(
    private readonly source: StatsSource,
    private readonly clock: Clock = systemClock,
  ) {}

  get latest(): ConnectionSnapshot | null {
    return this.#latest;
  }

  start(): void {
    if (this.#handle !== null) return;
    this.#handle = this.clock.setInterval(() => void this.#poll(), STATS.intervalMs);
    void this.#poll();
  }

  stop(): void {
    if (this.#handle !== null) this.clock.clearInterval(this.#handle);
    this.#handle = null;
  }

  async #poll(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      this.#ingest(parseStats(await this.source.getStats()));
    } catch {
      // The connection may be closing; the next tick (if any) will try again.
    } finally {
      this.#busy = false;
    }
  }

  #ingest(sample: StatsSample): void {
    const prev = this.#previous;
    const seconds = prev ? Math.max(0.001, (sample.timestamp - prev.timestamp) / 1000) : 0;
    const rate = (now: number, before: number | undefined): number =>
      prev && seconds > 0 ? Math.max(0, ((now - (before ?? 0)) * 8) / seconds) : 0;
    const sentDelta = prev ? Math.max(0, sample.bytesSent - prev.bytesSent) : sample.bytesSent;
    const receivedDelta = prev ? Math.max(0, sample.bytesReceived - prev.bytesReceived) : sample.bytesReceived;
    if (sample.path?.relayed) this.#relayedBytes += sentDelta + receivedDelta;

    const lost = sample.packetsLost - (prev?.packetsLost ?? 0);
    const received = sample.packetsReceived - (prev?.packetsReceived ?? 0);
    this.#previous = sample;
    this.#latest = {
      ...sample,
      sendBps: rate(sample.bytesSent, prev?.bytesSent),
      receiveBps: rate(sample.bytesReceived, prev?.bytesReceived),
      lossPercent: lost + received > 0 ? (100 * Math.max(0, lost)) / (lost + received) : null,
      relayedBytes: this.#relayedBytes,
    };
    this.events.emit('snapshot', this.#latest);
  }
}
