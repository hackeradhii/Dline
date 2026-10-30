import type { Signal } from '../../../contracts/signaling';
import { SerialQueue } from '../../../shared/async';

export interface SignalRoute {
  send(signal: Signal): boolean;
}

/**
 * MDN "perfect negotiation": either side may renegotiate at any time; on offer glare the polite
 * peer (guest) yields and the impolite peer (host) wins. Signals are processed strictly in order.
 */
export class Negotiator {
  #makingOffer = false;
  #ignoreOffer = false;
  #settingRemoteAnswer = false;
  #auto = false;
  readonly #queue = new SerialQueue();

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly polite: boolean,
    private readonly route: SignalRoute,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    pc.addEventListener('negotiationneeded', () => void this.#onNegotiationNeeded());
    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (this.#auto && candidate) this.route.send({ t: 'ice', c: candidate.toJSON() as Extract<Signal, { t: 'ice' }>['c'] });
    });
  }

  /** Start answering `negotiationneeded` automatically (off while a link exchange is in progress). */
  enableAuto(): void {
    this.#auto = true;
  }

  handle(signal: Signal): Promise<void> {
    return this.#queue.run(() => this.#handle(signal));
  }

  restartIce(): void {
    this.pc.restartIce();
  }

  async #onNegotiationNeeded(): Promise<void> {
    if (!this.#auto) return;
    try {
      this.#makingOffer = true;
      await this.pc.setLocalDescription();
      this.#sendLocalDescription();
    } catch (error) {
      this.onError(error);
    } finally {
      this.#makingOffer = false;
    }
  }

  async #handle(signal: Signal): Promise<void> {
    try {
      if (signal.t === 'sdp') await this.#onDescription(signal.d as RTCSessionDescriptionInit);
      else if (signal.t === 'ice' && signal.c) await this.#onCandidate(signal.c);
    } catch (error) {
      this.onError(error);
    }
  }

  async #onDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const readyForOffer = !this.#makingOffer && (this.pc.signalingState === 'stable' || this.#settingRemoteAnswer);
    const collision = description.type === 'offer' && !readyForOffer;
    this.#ignoreOffer = !this.polite && collision;
    if (this.#ignoreOffer) return;

    this.#settingRemoteAnswer = description.type === 'answer';
    await this.pc.setRemoteDescription(description);
    this.#settingRemoteAnswer = false;
    if (description.type === 'offer') {
      await this.pc.setLocalDescription();
      this.#sendLocalDescription();
    }
  }

  async #onCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      // Candidates for an offer we deliberately ignored are expected to fail.
      if (!this.#ignoreOffer) throw error;
    }
  }

  #sendLocalDescription(): void {
    const local = this.pc.localDescription;
    if (local) this.route.send({ t: 'sdp', d: { type: local.type, sdp: local.sdp } });
  }
}
