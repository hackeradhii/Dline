import type { ControlChannel, Signaler } from '../../../contracts/ports';
import type { Signal } from '../../../contracts/signaling';
import type { SignalRoute } from './negotiator';

type Path = (signal: Signal) => boolean;

/**
 * Sends negotiation signals over the best available path: the peer-to-peer `ctrl` channel while the
 * connection is healthy, otherwise the rendezvous server first. After a network switch `ctrl` still
 * reads "open" for half a minute or more (SCTP hasn't noticed the path is gone), and anything sent
 * on it is lost: the ICE restart that would find the new path must go through the server.
 */
export class SignalRouter implements SignalRoute {
  readonly #direct: Path = (signal) => this.control.isOpen && this.control.send(signal);
  readonly #server: Path = (signal) => !!this.signaler?.isConnected && this.signaler.send(signal);

  constructor(
    private readonly control: ControlChannel,
    private readonly signaler: Signaler | null,
    /** The direct path is carrying traffic right now (not recovering). */
    private readonly healthy: () => boolean,
  ) {}

  send(signal: Signal): boolean {
    const paths = this.healthy() ? [this.#direct, this.#server] : [this.#server, this.#direct];
    return paths.some((path) => path(signal));
  }

  /** Feeds signals from every inbound path into `handler`. Returns an unsubscribe function. */
  listen(handler: (signal: Signal) => void): () => void {
    const offs = [this.control.on('sdp', handler), this.control.on('ice', handler)];
    if (this.signaler) offs.push(this.signaler.onSignal(handler));
    return () => offs.forEach((off) => off());
  }
}
