import { createRoomCode } from '../../contracts/room';
import type { ServerErrorCode } from '../../contracts/signaling';
import { CallController } from '../../modules/call';
import { browserPeerFactory, Connection, LanePool, type FailureReason } from '../../modules/connection';
import { diagnoseNoPath, probeNetwork, remoteProfile, StatsMonitor, type NetworkProfile, type NoPathCause } from '../../modules/diagnostics';
import {
  createReply,
  deliverReply,
  HostLinkPairing,
  linkErrorReason,
  linkUrl,
  listenForReplies,
  parseFragment,
  peekSession,
  RendezvousSignaler,
  type LinkErrorReason,
} from '../../modules/pairing';
import { DEFAULT_TURN, directIceServers, iceServersFor, safeLocalStore, TurnSettings, type TurnConfig } from '../../modules/settings';
import { AdaptiveRateLimit, clearIncomingFiles, TransferManager } from '../../modules/transfer';
import { Disposer } from '../../shared/emitter';
import { clearFragment, KeepAwake, mediaDevices, onNetworkChange, pageBaseUrl, pageVisibility, switches } from '../browser';
import { RoomState, type RoomParts } from './room.svelte';

export type Screen =
  | { name: 'home' }
  | { name: 'hosting'; code: string; shareUrl: string }
  | { name: 'joining'; code: string }
  | { name: 'link-invite'; url: string | null }
  | { name: 'link-reply'; url: string | null }
  | { name: 'handoff'; delivered: boolean | null; reply: string }
  | { name: 'room' }
  | { name: 'ended'; reason: FailureReason; causes: NoPathCause[] };

/**
 * Composition root and app state machine. Wires concrete modules together (dependency inversion
 * happens here) and decides which screen is showing. Feature logic lives in the modules.
 */
export class Session {
  screen = $state.raw<Screen>({ name: 'home' });
  room = $state.raw<RoomState | null>(null);
  network = $state.raw<NetworkProfile | null>(null);
  checkingNetwork = $state(false);
  error = $state<string | null>(null);
  linkError = $state<LinkErrorReason | null>(null);
  serverError = $state<ServerErrorCode | null>(null);
  turn = $state.raw<TurnConfig>(DEFAULT_TURN);

  readonly #settings = new TurnSettings(safeLocalStore());
  readonly #awake = new KeepAwake();
  #disposer = new Disposer();
  #connection: Connection | null = null;
  #signaler: RendezvousSignaler | null = null;
  #hostPairing: HostLinkPairing | null = null;

  constructor() {
    this.turn = this.#settings.load();
    void clearIncomingFiles();
  }

  get relayEnabled(): boolean {
    return this.turn.enabled;
  }

  async checkNetwork(): Promise<void> {
    if (this.checkingNetwork || typeof RTCPeerConnection !== 'function') return;
    this.checkingNetwork = true;
    try {
      this.network = await probeNetwork(iceServersFor(this.#settings.load()));
    } catch {
      this.network = null;
    } finally {
      this.checkingNetwork = false;
    }
  }

  // ── Rendezvous rooms (default) ────────────────────────────────────────────

  startRoom(): void {
    const code = createRoomCode();
    this.#openRoom(code, true);
    this.screen = { name: 'hosting', code, shareUrl: linkUrl(pageBaseUrl(), `r.${code}`) };
  }

  joinRoom(code: string): void {
    this.#openRoom(code, false);
    this.screen = { name: 'joining', code };
  }

  // ── Serverless links (fallback) ───────────────────────────────────────────

  async startLinkInvite(): Promise<void> {
    this.#teardown();
    const connection = this.#newConnection('host', null);
    const pairing = new HostLinkPairing(connection, pageBaseUrl());
    this.#hostPairing = pairing;
    this.screen = { name: 'link-invite', url: null };
    this.#disposer.add(listenForReplies(pairing.session, (text) => this.applyReply(text)));
    try {
      this.screen = { name: 'link-invite', url: await pairing.createInvite() };
    } catch {
      this.#fatal('Could not create an invite. This browser may not support peer-to-peer connections.');
    }
  }

  /** Host pastes (or receives via another tab) the reply link. Returns whether it was applied. */
  async applyReply(input: string): Promise<boolean> {
    const fragment = parseFragment(input.slice(input.indexOf('#') + 1) || input);
    if (!this.#hostPairing) return false;
    if (!fragment || fragment.kind !== 'a') {
      this.linkError = fragment?.kind === 'o' ? 'kind' : 'malformed';
      return false;
    }
    try {
      await this.#hostPairing.applyReply(fragment.text);
      this.linkError = null;
      return true;
    } catch (error) {
      this.linkError = linkErrorReason(error);
      return false;
    }
  }

  // ── Entry from a URL fragment ─────────────────────────────────────────────

  async handleFragment(hash: string): Promise<void> {
    const fragment = parseFragment(hash);
    if (!fragment) return;
    clearFragment();
    if (fragment.kind === 'room') return this.joinRoom(fragment.code);
    if (fragment.kind === 'a') return this.#onReplyLink(fragment.text);

    this.#teardown();
    const connection = this.#newConnection('guest', null);
    this.screen = { name: 'link-reply', url: null };
    try {
      const { url } = await createReply(connection, fragment.text, pageBaseUrl());
      this.screen = { name: 'link-reply', url };
    } catch (error) {
      this.linkError = linkErrorReason(error);
      this.leave();
    }
  }

  // ── Leaving and settings ──────────────────────────────────────────────────

  leave(): void {
    this.#connection?.hangUp();
    this.#teardown();
    this.screen = { name: 'home' };
  }

  saveTurn(config: TurnConfig): string | null {
    const problem = this.#settings.save(config);
    if (!problem) this.turn = config;
    return problem;
  }

  dismissErrors(): void {
    this.error = null;
    this.linkError = null;
    this.serverError = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  async #onReplyLink(text: string): Promise<void> {
    if (this.#hostPairing) {
      await this.applyReply(`a.${text}`);
      return;
    }
    // Opened in a new tab: hand it to the tab that made the invite.
    const reply = linkUrl(pageBaseUrl(), `a.${text}`);
    this.screen = { name: 'handoff', delivered: null, reply };
    try {
      const delivered = await deliverReply(await peekSession('a', text), `a.${text}`);
      this.screen = { name: 'handoff', delivered, reply };
    } catch (error) {
      this.linkError = linkErrorReason(error);
      this.screen = { name: 'home' };
    }
  }

  #openRoom(code: string, create: boolean): void {
    this.#teardown();
    const signaler = new RendezvousSignaler({ origin: location.origin, code, create, onNetworkChange });
    this.#signaler = signaler;
    this.#newConnection(create ? 'host' : 'guest', signaler);
    this.#disposer.add(
      signaler.events.on('error', (code) => {
        if (this.screen.name === 'room') return;
        this.serverError = code;
        this.#teardown();
        this.screen = { name: 'home' };
      }),
    );
    signaler.connect();
  }

  /** Callers tear down any previous session first. */
  #newConnection(role: 'host' | 'guest', signaler: RendezvousSignaler | null): Connection {
    this.dismissErrors();
    const turn = this.#settings.load();
    const connection = new Connection({ role, signaler, iceServers: iceServersFor(turn), visibility: pageVisibility });
    this.#connection = connection;
    this.#disposer.add(connection.events.on('phase', (phase) => phase === 'connected' && this.#enterRoom(connection)));
    this.#disposer.add(connection.events.on('failure', (reason) => this.#onFailure(connection, reason)));
    return connection;
  }

  #enterRoom(connection: Connection): void {
    if (this.room) return;
    this.room = new RoomState(connection, this.#roomParts(connection));
    this.screen = { name: 'room' };
    this.#awake.set(true);
  }

  /** One room's modules, on top of its connection. */
  #roomParts(connection: Connection): RoomParts {
    const { control } = connection;
    const call = new CallController(control, connection, mediaDevices);
    const stats = new StatsMonitor(connection);
    const legacyPacing = new AdaptiveRateLimit();
    // STUN only: extra lanes are direct paths or nothing.
    const lanes = new LanePool({ control, main: connection, peers: browserPeerFactory, iceServers: directIceServers(), initiator: connection.role === 'host' });
    const files = new TransferManager({ control, lanes, legacy: legacyPacing, pacing: switches.pacing, visibility: pageVisibility });
    return { call, files, lanes, stats, legacyPacing };
  }

  #onFailure(connection: Connection, reason: FailureReason): void {
    const causes = reason === 'no-path' ? diagnoseNoPath(this.network, remoteProfile(connection.descriptions)) : [];
    this.#teardown();
    this.screen = { name: 'ended', reason, causes };
  }

  #fatal(message: string): void {
    this.#teardown();
    this.error = message;
    this.screen = { name: 'home' };
  }

  #teardown(): void {
    this.#disposer.dispose();
    this.#disposer = new Disposer();
    this.room?.dispose();
    this.room = null;
    this.#connection?.close();
    this.#connection = null;
    this.#signaler?.close();
    this.#signaler = null;
    this.#hostPairing = null;
    this.#awake.set(false);
  }
}
