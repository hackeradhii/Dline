import { CONNECTION } from '../../../shared/config';
import { systemClock, Timeout, type Clock } from '../../../shared/timer';

interface WatchdogActions {
  /** Try an ICE restart (the path may come back, e.g. after Wi-Fi → mobile). */
  restart(): void;
  /** Give up: the user needs a new connection. */
  lost(): void;
}

/**
 * Recovery policy for an established connection:
 * disconnected/failed for 5 s → ICE restart; still not connected after 15 s → lost.
 */
export class Watchdog {
  readonly #restart: Timeout;
  readonly #lost: Timeout;

  constructor(
    private readonly actions: WatchdogActions,
    clock: Clock = systemClock,
  ) {
    this.#restart = new Timeout(clock);
    this.#lost = new Timeout(clock);
  }

  onState(state: RTCPeerConnectionState): void {
    if (state === 'connected') return this.#clear();
    if (state !== 'disconnected' && state !== 'failed') return;
    if (state === 'failed') {
      this.#restart.clear();
      this.actions.restart();
    } else if (!this.#restart.pending) {
      this.#restart.set(() => this.actions.restart(), CONNECTION.restartAfterMs);
    }
    if (!this.#lost.pending) this.#lost.set(() => this.actions.lost(), CONNECTION.lostAfterMs);
  }

  stop(): void {
    this.#clear();
  }

  #clear(): void {
    this.#restart.clear();
    this.#lost.clear();
  }
}
