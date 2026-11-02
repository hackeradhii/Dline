import type { ControlChannel } from '../../../contracts/ports';
import { CONNECTION } from '../../../shared/config';
import { Disposer, Emitter } from '../../../shared/emitter';
import { systemClock, type Clock } from '../../../shared/timer';

interface HeartbeatEvents {
  rtt: number;
  responsive: boolean;
}

/**
 * Application-level liveness on `ctrl`: detects a silent peer faster than ICE does and keeps
 * carrier NAT mappings warm (mobile UDP timeouts are ~30–65 s).
 */
export class Heartbeat {
  readonly events = new Emitter<HeartbeatEvents>();
  readonly #disposer = new Disposer();
  #lastHeard: number;
  #responsive = true;

  constructor(
    private readonly control: ControlChannel,
    private readonly clock: Clock = systemClock,
  ) {
    this.#lastHeard = clock.now();
    this.#disposer.add(control.on('ping', ({ ts }) => {
      this.#heard();
      control.send({ t: 'pong', ts });
    }));
    this.#disposer.add(control.on('pong', ({ ts }) => {
      this.#heard();
      this.events.emit('rtt', Math.max(0, clock.now() - ts));
    }));
    const handle = clock.setInterval(() => this.#tick(), CONNECTION.heartbeatIntervalMs);
    this.#disposer.add(() => clock.clearInterval(handle));
  }

  stop(): void {
    this.#disposer.dispose();
  }

  #tick(): void {
    this.control.send({ t: 'ping', ts: this.clock.now() });
    if (this.clock.now() - this.#lastHeard > CONNECTION.heartbeatTimeoutMs) this.#setResponsive(false);
  }

  #heard(): void {
    this.#lastHeard = this.clock.now();
    this.#setResponsive(true);
  }

  #setResponsive(value: boolean): void {
    if (value === this.#responsive) return;
    this.#responsive = value;
    this.events.emit('responsive', value);
  }
}
