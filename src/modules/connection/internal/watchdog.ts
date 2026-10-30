import { CONNECTION } from '../../../shared/config';
import { systemClock, type Clock } from '../../../shared/timer';

export interface WatchdogActions {
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
  #restartTimer: unknown = null;
  #lostTimer: unknown = null;

  constructor(
    private readonly actions: WatchdogActions,
    private readonly clock: Clock = systemClock,
  ) {}

  onState(state: RTCPeerConnectionState): void {
    if (state === 'connected') return this.#clear();
    if (state !== 'disconnected' && state !== 'failed') return;
    if (state === 'failed') {
      this.#cancelRestart();
      this.actions.restart();
    } else {
      this.#restartTimer ??= this.clock.setTimeout(() => {
        this.#restartTimer = null;
        this.actions.restart();
      }, CONNECTION.restartAfterMs);
    }
    this.#lostTimer ??= this.clock.setTimeout(() => {
      this.#lostTimer = null;
      this.actions.lost();
    }, CONNECTION.lostAfterMs);
  }

  stop(): void {
    this.#clear();
  }

  #cancelRestart(): void {
    if (this.#restartTimer !== null) this.clock.clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }

  #clear(): void {
    this.#cancelRestart();
    if (this.#lostTimer !== null) this.clock.clearTimeout(this.#lostTimer);
    this.#lostTimer = null;
  }
}
