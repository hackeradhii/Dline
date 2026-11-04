/**
 * Ports (interfaces) between modules and towards the browser.
 * Small, role-specific interfaces (ISP); modules depend on these, never on concrete classes (DIP).
 */
import type { Unsubscribe } from '../shared/emitter';
import type { ControlMessage, ControlOf, ControlType } from './control';
import type { MetricsEvent } from './metrics';
import type { Signal } from './signaling';

/** Typed messaging over the `ctrl` data channel. */
export interface ControlChannel {
  readonly isOpen: boolean;
  send(message: ControlMessage): boolean;
  on<T extends ControlType>(type: T, handler: (message: ControlOf<T>) => void): Unsubscribe;
}

/** Opens extra data channels on a connection. */
export interface ChannelFactory {
  /** Largest message to send (the peer's SCTP max-message-size, capped). */
  readonly maxMessageSize: number;
  openChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel;
}

/** One path for bulk data: a reliable, ordered data channel with its own SCTP congestion window. */
export interface Lane {
  readonly id: number;
  readonly channel: RTCDataChannel;
  /** Largest message to send on this lane. */
  readonly chunkBytes: number;
}

/** The lanes open right now. Lanes come and go: each new one is announced once; a closed one closes its channel. */
export interface LaneSource {
  readonly lanes: readonly Lane[];
  onLane(handler: (lane: Lane) => void): Unsubscribe;
}

export interface StatsSource {
  getStats(): Promise<RTCStatsReport>;
}

/** The slice of the peer connection the call module needs. */
export interface TransceiverHost {
  addTransceiver(trackOrKind: MediaStreamTrack | 'audio' | 'video', init: RTCRtpTransceiverInit): RTCRtpTransceiver;
  getTransceivers(): RTCRtpTransceiver[];
  onTrack(handler: (event: RTCTrackEvent) => void): Unsubscribe;
}

/** A real-time signaling path (rendezvous today; Nostr/MQTT could be added without touching consumers). */
export interface Signaler {
  readonly isConnected: boolean;
  send(signal: Signal): boolean;
  onSignal(handler: (signal: Signal) => void): Unsubscribe;
  /** The other peer joined (true) or dropped off (false) the signaling path. */
  onPeerPresence(handler: (present: boolean) => void): Unsubscribe;
}

export interface PeerFactory {
  create(config: RTCConfiguration): RTCPeerConnection;
}

export interface MediaDevicesPort {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Where performance reports go (the Worker's log). Fire and forget: a lost report is fine. */
export interface MetricsSink {
  send(event: MetricsEvent): void;
}

/** SHA-256 of one block, as lowercase hex. */
export interface BlockHasher {
  digest(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string>;
}

/** Where received bytes go. All implementations must pass the shared FileSink contract tests (LSP). */
export interface FileSink {
  /** Stores `data` at byte `offset`. Writes come in any order and together cover the file exactly once. */
  write(offset: number, data: ArrayBuffer): Promise<void>;
  /** Finishes writing and returns the stored file. */
  close(): Promise<Blob>;
  abort(): Promise<void>;
}
