import type { ChannelFactory, PeerFactory, Signaler, StatsSource, TransceiverHost } from '../../../contracts/ports';
import type { Role, Signal } from '../../../contracts/signaling';
import { CONNECTION, LINK, TRANSFER } from '../../../shared/config';
import { Disposer, Emitter, type Unsubscribe } from '../../../shared/emitter';
import { alwaysVisible, systemClock, VisibleTimer, type Clock, type Visibility } from '../../../shared/timer';
import { DataControlChannel } from './control-channel';
import { waitForGathering } from './gathering';
import { Heartbeat } from './heartbeat';
import { Negotiator } from './negotiator';
import { chunkSize } from './sctp';
import { SignalRouter } from './signal-router';
import { Watchdog } from './watchdog';

export type ConnectionPhase = 'waiting' | 'connecting' | 'connected' | 'unstable' | 'lost' | 'closed';
/** Why a connection ended: no direct path found, path died, or the other person left. */
export type FailureReason = 'no-path' | 'lost' | 'peer-left';

export interface ConnectionEvents {
  phase: ConnectionPhase;
  rtt: number;
  failure: FailureReason;
  error: unknown;
}

export interface ConnectionOptions {
  role: Role;
  iceServers: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  /** Real-time signaling (rendezvous). Absent in link mode. */
  signaler?: Signaler | null;
  peerFactory?: PeerFactory;
  clock?: Clock;
  visibility?: Visibility;
}

/** The serverless link exchange: offer/answer with all candidates baked in. */
export interface ManualExchange {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
  acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void>;
}

export const CONTROL_LABEL = 'ctrl';

export const browserPeerFactory: PeerFactory = { create: (config) => new RTCPeerConnection(config) };

/**
 * One peer-to-peer session. Composes negotiation, the control channel, heartbeat and recovery,
 * and exposes small ports (ChannelFactory, StatsSource, TransceiverHost) to feature modules.
 */
export class Connection implements ChannelFactory, StatsSource, TransceiverHost, ManualExchange {
  readonly control = new DataControlChannel();
  readonly events = new Emitter<ConnectionEvents>();
  readonly role: Role;
  readonly mode: 'rendezvous' | 'link';

  readonly #pc: RTCPeerConnection;
  readonly #negotiator: Negotiator;
  readonly #signaler: Signaler | null;
  readonly #clock: Clock;
  readonly #visibility: Visibility;
  readonly #watchdog: Watchdog;
  readonly #disposer = new Disposer();
  readonly #tracks = new Emitter<{ track: RTCTrackEvent }>();
  readonly #remoteCandidates: string[] = [];
  #heartbeat: Heartbeat | null = null;
  #connectTimer: VisibleTimer | null = null;
  #phase: ConnectionPhase = 'waiting';
  #responsive = true;

  constructor(options: ConnectionOptions) {
    this.role = options.role;
    this.#signaler = options.signaler ?? null;
    this.mode = this.#signaler ? 'rendezvous' : 'link';
    this.#clock = options.clock ?? systemClock;
    this.#visibility = options.visibility ?? alwaysVisible;
    this.#pc = (options.peerFactory ?? browserPeerFactory).create({
      iceServers: options.iceServers,
      iceTransportPolicy: options.iceTransportPolicy ?? 'all',
    });

    const router = new SignalRouter(this.control, this.#signaler);
    this.#negotiator = new Negotiator(this.#pc, this.role === 'guest', router, (e) => this.events.emit('error', e));
    if (this.mode === 'rendezvous') this.#negotiator.enableAuto();
    this.#disposer.add(router.listen((signal) => this.#onSignal(signal)));
    this.#disposer.add(this.control.on('bye', () => this.#fail('peer-left')));
    this.#disposer.add(this.control.events.on('open', () => this.#onControlOpen()));
    // A clean channel close while the path is up means the other tab closed; otherwise the path died.
    this.#disposer.add(this.control.events.on('close', () => this.#fail(this.#pc.connectionState === 'connected' ? 'peer-left' : 'lost')));

    this.#watchdog = new Watchdog({ restart: () => this.restartIce(), lost: () => this.#fail('lost') }, this.#clock);
    this.#pc.addEventListener('connectionstatechange', () => this.#onPeerState());
    this.#pc.addEventListener('track', (event) => this.#tracks.emit('track', event));
    this.#pc.addEventListener('datachannel', ({ channel }) => this.#onIncomingChannel(channel));

    if (this.#signaler) {
      this.#disposer.add(this.#signaler.onPeerPresence((present) => this.#onPeerPresence(present)));
    }
  }

  get phase(): ConnectionPhase {
    return this.#phase;
  }

  get maxMessageSize(): number {
    return chunkSize(this.#pc.sctp, TRANSFER.chunkBytes);
  }

  /** Local and remote session descriptions plus trickled remote candidates (for diagnostics). */
  get descriptions(): { local: string; remote: string; remoteCandidates: readonly string[] } {
    return {
      local: this.#pc.localDescription?.sdp ?? '',
      remote: this.#pc.remoteDescription?.sdp ?? '',
      remoteCandidates: this.#remoteCandidates,
    };
  }

  // ── Link mode (ManualExchange) ────────────────────────────────────────────

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.#createControlChannel();
    await this.#pc.setLocalDescription();
    return this.#gatheredLocalDescription();
  }

  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.#pc.setRemoteDescription(offer);
    await this.#pc.setLocalDescription();
    this.#setPhase('connecting');
    return this.#gatheredLocalDescription();
  }

  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.#pc.setRemoteDescription(answer);
    this.expectConnection();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Both descriptions are (or are about to be) in place: from now on, failing to open `ctrl` within
   * the timeout means there is no direct path. The countdown pauses while the page is hidden.
   */
  expectConnection(): void {
    if (this.#connectTimer || this.#phase === 'connected') return;
    this.#setPhase('connecting');
    this.#connectTimer = new VisibleTimer(CONNECTION.connectTimeoutMs, () => this.#fail('no-path'), this.#clock, this.#visibility);
  }

  restartIce(): void {
    if (this.#over) return;
    this.#negotiator.restartIce();
  }

  /** Leave on purpose: tell the peer, then tear everything down. */
  hangUp(): void {
    const bye: Signal = { t: 'bye' };
    if (!this.control.send(bye)) this.#signaler?.send(bye);
    this.close();
  }

  close(): void {
    if (this.#phase === 'closed') return;
    this.#stopTimers();
    this.#disposer.dispose();
    this.control.close();
    this.#pc.close();
    this.#setPhase('closed');
  }

  // ── Ports for feature modules ────────────────────────────────────────────

  openChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
    const channel = this.#pc.createDataChannel(label, init);
    channel.binaryType = 'arraybuffer';
    return channel;
  }

  getStats(): Promise<RTCStatsReport> {
    return this.#pc.getStats();
  }

  addTransceiver(trackOrKind: MediaStreamTrack | 'audio' | 'video', init: RTCRtpTransceiverInit): RTCRtpTransceiver {
    return this.#pc.addTransceiver(trackOrKind, init);
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return this.#pc.getTransceivers();
  }

  onTrack(handler: (event: RTCTrackEvent) => void): Unsubscribe {
    return this.#tracks.on('track', handler);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Lost or closed: nothing will bring this connection back. */
  get #over(): boolean {
    return this.#phase === 'lost' || this.#phase === 'closed';
  }

  #createControlChannel(): void {
    if (this.control.isOpen) return;
    this.control.attach(this.openChannel(CONTROL_LABEL, { ordered: true }));
  }

  async #gatheredLocalDescription(): Promise<RTCSessionDescriptionInit> {
    await waitForGathering(this.#pc, LINK.gatherTimeoutMs, this.#clock);
    const local = this.#pc.localDescription;
    if (!local) throw new Error('No local description');
    return { type: local.type, sdp: local.sdp };
  }

  #onSignal(signal: Signal): void {
    if (signal.t === 'bye') return this.#fail('peer-left');
    if (signal.t === 'ice' && signal.c) this.#remoteCandidates.push(signal.c.candidate);
    if (signal.t === 'sdp' && this.#phase === 'waiting') this.expectConnection();
    void this.#negotiator.handle(signal);
  }

  #onPeerPresence(present: boolean): void {
    if (!present) return;
    if (this.#phase === 'waiting' && this.role === 'host') {
      this.expectConnection();
      this.#createControlChannel(); // Fires negotiationneeded → offer over the rendezvous socket.
    } else if (this.#phase === 'unstable') {
      this.restartIce(); // They came back (e.g. switched networks): find a new path.
    }
  }

  #onIncomingChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    // Only `ctrl` is announced in-band; everything else is negotiated (lanes) or unknown.
    if (channel.label === CONTROL_LABEL) this.control.attach(channel);
    else channel.close();
  }

  #onControlOpen(): void {
    this.#connectTimer?.cancel();
    this.#connectTimer = null;
    this.#negotiator.enableAuto();
    if (!this.#heartbeat) {
      this.#heartbeat = new Heartbeat(this.control, this.#clock);
      this.#heartbeat.events.on('rtt', (rtt) => this.events.emit('rtt', rtt));
      this.#heartbeat.events.on('responsive', (responsive) => {
        this.#responsive = responsive;
        this.#onPeerState();
      });
    }
    this.#onPeerState();
  }

  #onPeerState(): void {
    if (this.#over) return;
    const state = this.#pc.connectionState;
    if (!this.control.isOpen) {
      // ICE gave up before we ever connected, while we were expecting a connection: no direct path.
      if (state === 'failed' && this.#connectTimer) this.#fail('no-path');
      return;
    }
    this.#watchdog.onState(state);
    const healthy = state === 'connected' && this.#responsive;
    this.#setPhase(healthy ? 'connected' : 'unstable');
  }

  #fail(reason: FailureReason): void {
    if (this.#over) return;
    this.#stopTimers();
    this.#setPhase('lost');
    this.events.emit('failure', reason);
  }

  #stopTimers(): void {
    this.#connectTimer?.cancel();
    this.#connectTimer = null;
    this.#watchdog.stop();
    this.#heartbeat?.stop();
    this.#heartbeat = null;
  }

  #setPhase(phase: ConnectionPhase): void {
    if (phase === this.#phase) return;
    this.#phase = phase;
    this.events.emit('phase', phase);
  }
}
