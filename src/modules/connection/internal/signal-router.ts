import type { ControlChannel, Signaler } from '../../../contracts/ports';
import type { Signal } from '../../../contracts/signaling';
import type { SignalRoute } from './negotiator';

/**
 * Sends negotiation signals over the best available path: the peer-to-peer `ctrl` channel when it
 * is open, otherwise the rendezvous server (needed for ICE restarts after a network switch).
 */
export class SignalRouter implements SignalRoute {
  constructor(
    private readonly control: ControlChannel,
    private readonly signaler: Signaler | null,
  ) {}

  send(signal: Signal): boolean {
    if (this.control.isOpen && this.control.send(signal)) return true;
    return this.signaler?.isConnected ? this.signaler.send(signal) : false;
  }

  /** Feeds signals from every inbound path into `handler`. Returns an unsubscribe function. */
  listen(handler: (signal: Signal) => void): () => void {
    const offs = [this.control.on('sdp', handler), this.control.on('ice', handler)];
    if (this.signaler) offs.push(this.signaler.onSignal(handler));
    return () => offs.forEach((off) => off());
  }
}
