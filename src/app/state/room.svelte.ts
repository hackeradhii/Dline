import type { MediaDevicesPort } from '../../contracts/ports';
import { CallController, type CallNotice, type CallState, type MediaFlags } from '../../modules/call';
import { browserPeerFactory, LanePool, type Connection, type ConnectionPhase } from '../../modules/connection';
import { safetyCode, StatsMonitor, type ConnectionSnapshot } from '../../modules/diagnostics';
import { AdaptiveRateLimit, TransferManager, type TransferItem } from '../../modules/transfer';
import { Disposer } from '../../shared/emitter';

const NO_MEDIA: MediaFlags = { audio: false, video: false };

/**
 * Reactive view of one connected session: composes the call, transfer and diagnostics modules on
 * top of the connection and mirrors their events into Svelte state. Holds no business rules itself.
 */
export class RoomState {
  phase = $state<ConnectionPhase>('connected');
  rtt = $state<number | null>(null);
  snapshot = $state.raw<ConnectionSnapshot | null>(null);
  safetyWords = $state.raw<string[] | null>(null);

  callState = $state<CallState>('idle');
  localStream = $state.raw<MediaStream | null>(null);
  remoteStream = $state.raw<MediaStream | null>(null);
  localMedia = $state.raw<MediaFlags>(NO_MEDIA);
  remoteMedia = $state.raw<MediaFlags>(NO_MEDIA);
  callNotice = $state<CallNotice | null>(null);
  cameraCount = $state(0);

  transfers = $state.raw<TransferItem[]>([]);
  /** Parallel paths carrying files right now, the main connection included. */
  lanes = $state(0);

  readonly call: CallController;
  readonly files: TransferManager;
  readonly #lanes: LanePool;
  readonly #stats: StatsMonitor;
  readonly #disposer = new Disposer();
  // Not reactive on purpose: `transfers` is reassigned as a new array on every change.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #items = new Map<string, TransferItem>();

  constructor(
    readonly connection: Connection,
    devices: MediaDevicesPort,
    /** STUN only: extra lanes are direct paths or nothing. */
    laneIceServers: RTCIceServer[],
  ) {
    this.call = new CallController(connection.control, connection, devices);
    this.#stats = new StatsMonitor(connection);
    const pacing = new AdaptiveRateLimit();
    const { control } = connection;
    this.#lanes = new LanePool({ control, main: connection, peers: browserPeerFactory, iceServers: laneIceServers, initiator: connection.role === 'host' });
    this.files = new TransferManager({ control, lanes: this.#lanes, rateLimit: () => pacing.limit });

    const on = this.#disposer.add.bind(this.#disposer);
    on(connection.events.on('phase', (p) => (this.phase = p)));
    on(connection.events.on('rtt', (r) => (this.rtt = r)));
    on(this.#lanes.events.on('count', (n) => (this.lanes = n)));
    this.lanes = this.#lanes.lanes.length;
    on(
      this.#stats.events.on('snapshot', (s) => {
        this.snapshot = s;
        const sample = { callActive: this.call.state === 'active', rttMs: s.rttMs, lossPercent: s.lossPercent };
        pacing.update(sample, this.files.uploadBytesPerSecond);
        // Extra lanes only alongside a direct main path: if that needed a relay, a direct lane won't open either.
        if (s.path && !s.path.relayed && this.phase === 'connected') this.#lanes.fit(s.rttMs);
      }),
    );
    on(this.call.events.on('state', (s) => (this.callState = s)));
    on(this.call.events.on('localStream', (s) => (this.localStream = s)));
    on(this.call.events.on('remoteStream', (s) => (this.remoteStream = s)));
    on(this.call.events.on('localMedia', (m) => (this.localMedia = m)));
    on(this.call.events.on('remoteMedia', (m) => (this.remoteMedia = m)));
    on(this.call.events.on('notice', (n) => (this.callNotice = n)));
    on(this.files.events.on('changed', (item) => this.#onTransfer(item)));

    this.#stats.start();
    void this.#loadSafetyCode();
    void this.call.cameraCount.then((n) => (this.cameraCount = n));
  }

  /** True while something would be lost by closing the tab. */
  get busy(): boolean {
    return this.callState !== 'idle' || this.transfers.some((t) => t.status === 'transferring' || t.status === 'queued');
  }

  dismissNotice(): void {
    this.callNotice = null;
  }

  dispose(): void {
    this.#disposer.dispose();
    this.#stats.stop();
    this.call.dispose();
    this.files.dispose();
    this.#lanes.close();
  }

  #onTransfer(item: TransferItem): void {
    this.#items.set(item.id, item);
    this.transfers = [...this.#items.values()];
  }

  async #loadSafetyCode(): Promise<void> {
    const { local, remote } = this.connection.descriptions;
    this.safetyWords = await safetyCode(local, remote);
  }
}
