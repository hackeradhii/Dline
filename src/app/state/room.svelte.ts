import type { CallController, CallNotice, CallState, MediaFlags } from '../../modules/call';
import type { Connection, ConnectionPhase, LanePool } from '../../modules/connection';
import { safetyCode, type ConnectionSnapshot, type StatsMonitor } from '../../modules/diagnostics';
import type { AdaptiveRateLimit, PacingStatus, TransferItem, TransferManager } from '../../modules/transfer';
import { Disposer } from '../../shared/emitter';

const NO_MEDIA: MediaFlags = { audio: false, video: false };

/** One connected session's modules, wired by the composition root (`Session`). */
export interface RoomParts {
  call: CallController;
  files: TransferManager;
  lanes: LanePool;
  stats: StatsMonitor;
  /** The legacy file budget, fed from each stats tick. */
  legacyPacing: AdaptiveRateLimit;
}

/**
 * Reactive view of one connected session: mirrors the call, transfer and diagnostics modules'
 * events into Svelte state, and hands each stats tick to the modules that use it.
 */
export class RoomState {
  phase = $state<ConnectionPhase>('connected');
  rtt = $state<number | null>(null);
  snapshot = $state.raw<ConnectionSnapshot | null>(null);
  safetyWords = $state.raw<string[] | null>(null);
  /** File pacing as of the last stats tick (PLAN.md §5.7). */
  pacing = $state.raw<PacingStatus | null>(null);

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
    { call, files, lanes, stats, legacyPacing }: RoomParts,
  ) {
    this.call = call;
    this.files = files;
    this.#lanes = lanes;
    this.#stats = stats;

    const on = this.#disposer.add.bind(this.#disposer);
    on(connection.events.on('phase', (p) => (this.phase = p)));
    on(connection.events.on('rtt', (r) => (this.rtt = r)));
    on(lanes.events.on('count', (n) => (this.lanes = n)));
    this.lanes = lanes.lanes.length;
    on(
      stats.events.on('snapshot', (s) => {
        this.snapshot = s;
        const sample = { callActive: call.state === 'active', rttMs: s.rttMs, lossPercent: s.lossPercent };
        legacyPacing.update(sample, files.uploadBytesPerSecond);
        files.setFlowInputs({ mediaSendBps: s.mediaSendBps, pathKey: s.pairId, pathRttMs: s.rttMs });
        this.pacing = files.pacing;
        lanes.fit(s.rttMs, !!s.path && !s.path.relayed && this.phase === 'connected');
      }),
    );
    // The call reaches file pacing the moment it changes, not a stats tick later (FLOW-06).
    on(
      call.events.on('state', (s) => {
        this.callState = s;
        files.setFlowInputs({ callActive: s === 'active' });
      }),
    );
    // Files first (PLAN-FILES-FIRST): Flow's reserve follows the cap the sender actually has.
    on(call.events.on('videoCap', (cap) => files.setFlowInputs({ videoCapBps: cap?.maxBitrateBps ?? null })));
    on(files.events.on('sending', (sending) => void call.setSendingFiles(sending)));
    on(call.events.on('localStream', (s) => (this.localStream = s)));
    on(call.events.on('remoteStream', (s) => (this.remoteStream = s)));
    on(
      call.events.on('localMedia', (m) => {
        this.localMedia = m;
        files.setFlowInputs({ videoOn: m.video });
      }),
    );
    on(call.events.on('remoteMedia', (m) => (this.remoteMedia = m)));
    on(call.events.on('notice', (n) => (this.callNotice = n)));
    on(files.events.on('changed', (item) => this.#onTransfer(item)));

    stats.start();
    void this.#loadSafetyCode();
    void call.cameraCount.then((n) => (this.cameraCount = n));
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
