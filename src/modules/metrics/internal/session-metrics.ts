import type { SessionEnd } from '../../../contracts/metrics';
import { systemClock, type Clock } from '../../../shared/timer';
import type { FinishedTransfer, MetricsReporter, ReportContext } from './reporter';
import { SessionTally, type TallyItem, type TallySnapshot } from './session-tally';

/**
 * One connected session's performance: the tally the app shows, plus what the session report
 * needs (call time, recoveries, most lanes). The room feeds it; it reports through the reporter.
 */
export class SessionMetrics {
  readonly #tally = new SessionTally();
  readonly #started: number;
  #lastTick: number;
  #context: ReportContext = { path: null, rttMs: null, lanes: 0, call: false, pacing: 'off' };
  #callMs = 0;
  #maxLanes = 0;
  #recoveries = 0;

  constructor(
    private readonly reporter: MetricsReporter,
    private readonly clock: Clock = systemClock,
  ) {
    this.#started = this.#lastTick = clock.now();
  }

  /** Every transfer change; a finished one is reported in the context of the last tick. */
  transfer(item: TallyItem & FinishedTransfer): void {
    this.#tally.observe(item);
    this.reporter.transferEnded(item, this.#context);
  }

  /** The once-a-second stats tick. */
  tick(context: ReportContext): TallySnapshot {
    const now = this.clock.now();
    const elapsed = now - this.#lastTick;
    this.#lastTick = now;
    if (this.#context.call) this.#callMs += elapsed;
    this.#context = context;
    this.#maxLanes = Math.max(this.#maxLanes, context.lanes);
    if (context.path) this.reporter.connected(context.path, context.rttMs);
    return this.#tally.tick(elapsed);
  }

  /** The connection became unstable and is recovering. */
  unstable(): void {
    this.#recoveries++;
  }

  end(reason: SessionEnd): void {
    const now = this.clock.now();
    const { up, down } = this.#tally.snapshot();
    this.reporter.sessionEnded({
      end: reason,
      ms: now - this.#started,
      up,
      down,
      callMs: this.#callMs + (this.#context.call ? now - this.#lastTick : 0),
      maxLanes: this.#maxLanes,
      recoveries: this.#recoveries,
      path: this.#context.path,
    });
  }
}
