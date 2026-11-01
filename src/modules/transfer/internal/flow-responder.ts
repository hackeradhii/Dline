import { wireMs } from '../../../contracts/flow';
import type { ControlChannel } from '../../../contracts/ports';
import { FLOW } from '../../../shared/config';
import { Disposer } from '../../../shared/emitter';
import type { Clock } from '../../../shared/timer';

/**
 * The receiver's side of the feedback (PLAN.md §5.1), in every mode: echoes each probe straight
 * away with its own arrival time and the bulk bytes received so far, and answers drain markers.
 * At most one echo per `minEchoGapMs`, so a misbehaving peer can't make it echo without bound.
 */
export class FlowResponder {
  readonly #disposer = new Disposer();
  #bytes = 0;
  #lastEchoAt = -Infinity;

  constructor(
    private readonly control: ControlChannel,
    private readonly clock: Clock,
  ) {
    this.#disposer.add(control.on('flow-probe', (m) => this.#echo(m.s, m.ts)));
  }

  /** Bulk bytes arrived on a lane. Copies count too: they used the link as well. */
  received(bytes: number): void {
    this.#bytes += bytes;
  }

  /** Drain marker `m` arrived on lane `n`: everything sent before it on that lane is in. */
  marked(m: number, n: number): void {
    this.control.send({ t: 'flow-mark', m, n });
  }

  dispose(): void {
    this.#disposer.dispose();
  }

  #echo(s: number, ts: number): void {
    const now = this.clock.now();
    if (now - this.#lastEchoAt < FLOW.minEchoGapMs) return;
    this.#lastEchoAt = now;
    this.control.send({ t: 'flow-echo', s, ts, ra: wireMs(now), rb: this.#bytes });
  }
}
