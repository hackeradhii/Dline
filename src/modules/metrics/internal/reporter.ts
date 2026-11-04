import type { MetricsCommon, MetricsEvent, MetricsOf, MetricsPath, MetricsProfile, MetricsSide, SessionEnd } from '../../../contracts/metrics';
import type { MetricsSink } from '../../../contracts/ports';
import { isFinished, type TransferDirection } from '../../../contracts/transfer';
import { systemClock, type Clock } from '../../../shared/timer';
import type { SideTally } from './session-tally';

/** The live context of a transfer or session: how the line looked when it was reported. */
export interface ReportContext {
  path: MetricsPath | null;
  rttMs: number | null;
  lanes: number;
  call: boolean;
  pacing: string;
}

/** The slice of a finished transfer a report reads (a `TransferItem` fits). */
export interface FinishedTransfer {
  readonly id: string;
  readonly direction: TransferDirection;
  readonly status: string;
  readonly error: string | null;
  readonly size: number;
  readonly bytes: number;
  readonly elapsedMs: number;
  readonly verified: boolean | null;
}

export interface SessionTotals {
  end: SessionEnd;
  ms: number;
  up: SideTally;
  down: SideTally;
  callMs: number;
  maxLanes: number;
  recoveries: number;
  path: MetricsPath | null;
}

interface ReporterDeps {
  sink: MetricsSink;
  /** The user's choice (Settings): off sends nothing. */
  enabled: boolean;
  common: MetricsCommon;
  clock?: Clock;
}

const round = (value: number): number => Math.max(0, Math.round(value));
const optional = <T>(value: T | null | undefined): T | undefined => value ?? undefined;
const side = (s: SideTally): MetricsSide => ({ bytes: round(s.bytes), files: s.files, failed: s.failed, avgBps: round(s.avgBps), peakBps: round(s.peakBps) });

/**
 * Turns one connection's facts into performance reports and sends each at most once: the connect
 * result, every finished transfer, and the session's totals at the end.
 */
export class MetricsReporter {
  readonly #clock: Clock;
  readonly #created: number;
  readonly #transfers = new Set<string>();
  #connectingSince: number | null = null;
  #connectSent = false;
  #sessionSent = false;

  constructor(private readonly deps: ReporterDeps) {
    this.#clock = deps.clock ?? systemClock;
    this.#created = this.#clock.now();
  }

  /** Both peers are present and ICE starts: connect time is measured from here. */
  connecting(): void {
    this.#connectingSince ??= this.#clock.now();
  }

  /** The first reading of the connected path. */
  connected(path: MetricsPath | null, rttMs: number | null): void {
    this.#connect({ outcome: 'connected', path: optional(path), rttMs: optional(rttMs === null ? null : round(rttMs)) });
  }

  failed(causes: readonly string[], local: MetricsProfile | null, remote: MetricsProfile | null): void {
    this.#connect({ outcome: 'failed', causes: [...causes], local: optional(local), remote: optional(remote) });
  }

  transferEnded(item: FinishedTransfer, context: ReportContext): void {
    const { status } = item;
    if (this.#transfers.has(item.id) || !isFinished(status)) return;
    this.#transfers.add(item.id);
    this.#send({
      t: 'transfer',
      ...this.deps.common,
      direction: item.direction,
      status,
      error: optional(item.error),
      size: round(item.size),
      bytes: round(item.bytes),
      ms: round(item.elapsedMs),
      bps: item.elapsedMs > 0 ? round((item.bytes * 1000) / item.elapsedMs) : 0,
      verified: item.verified === true,
      lanes: context.lanes,
      call: context.call,
      pacing: context.pacing,
      path: optional(context.path),
      rttMs: optional(context.rttMs === null ? null : round(context.rttMs)),
    });
  }

  sessionEnded(totals: SessionTotals): void {
    if (this.#sessionSent) return;
    this.#sessionSent = true;
    this.#send({
      t: 'session',
      ...this.deps.common,
      end: totals.end,
      ms: round(totals.ms),
      up: side(totals.up),
      down: side(totals.down),
      callMs: round(totals.callMs),
      maxLanes: totals.maxLanes,
      recoveries: totals.recoveries,
      path: optional(totals.path),
    });
  }

  #connect(fields: Omit<MetricsOf<'connect'>, 't' | 'ms' | keyof MetricsCommon>): void {
    if (this.#connectSent) return;
    this.#connectSent = true;
    this.#send({ t: 'connect', ...this.deps.common, ms: round(this.#clock.now() - (this.#connectingSince ?? this.#created)), ...fields });
  }

  #send(event: MetricsEvent): void {
    if (!this.deps.enabled) return;
    try {
      this.deps.sink.send(event);
    } catch {
      // Reports are best effort: never let one break the session.
    }
  }
}
