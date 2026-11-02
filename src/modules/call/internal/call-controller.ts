import type { ControlChannel, MediaDevicesPort, TransceiverHost } from '../../../contracts/ports';
import { MEDIA } from '../../../shared/config';
import { Disposer, Emitter } from '../../../shared/emitter';
import { LocalMedia, MediaError, type MediaFailure } from './local-media';
import { TransceiverSlots, type MediaKind, type VideoCap } from './transceiver-slots';
import { VideoCapper } from './video-capper';

export type CallState = 'idle' | 'outgoing' | 'incoming' | 'active';
export type CallNotice = 'declined' | 'ended' | 'busy' | MediaFailure;

export interface MediaFlags {
  audio: boolean;
  video: boolean;
}

interface CallEvents {
  state: CallState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  localMedia: MediaFlags;
  remoteMedia: MediaFlags;
  notice: CallNotice;
  /** The video cap actually applied to the sender right now (null: none). */
  videoCap: VideoCap | null;
}

const OFF: MediaFlags = { audio: false, video: false };

/**
 * One-to-one video call on top of an existing connection.
 * ring → accept/decline over `ctrl`; media is negotiated by the connection (perfect negotiation).
 */
export class CallController {
  readonly events = new Emitter<CallEvents>();
  readonly #media: LocalMedia;
  readonly #slots: TransceiverSlots;
  readonly #disposer = new Disposer();
  #state: CallState = 'idle';
  #isCaller = false;
  #flags: MediaFlags = OFF;
  readonly #capper: VideoCapper;

  constructor(
    private readonly control: ControlChannel,
    host: TransceiverHost,
    devices: MediaDevicesPort,
  ) {
    this.#media = new LocalMedia(devices);
    this.#slots = new TransceiverSlots(host);
    this.#capper = new VideoCapper(
      this.#slots,
      () => (this.#state === 'active' ? this.#media.video : null),
      (cap) => this.events.emit('videoCap', cap),
    );
    this.#disposer.add(control.on('ring', () => this.#onRing()));
    this.#disposer.add(control.on('accept', () => void this.#onAccepted()));
    this.#disposer.add(control.on('decline', () => this.#end('declined')));
    this.#disposer.add(control.on('hangup', () => this.#end('ended')));
    this.#disposer.add(control.on('media', ({ audio, video }) => this.events.emit('remoteMedia', { audio, video })));
    this.#disposer.add(host.onTrack(() => void this.#onRemoteTrack()));
  }

  get state(): CallState {
    return this.#state;
  }

  get cameraCount(): Promise<number> {
    return this.#media.cameraCount();
  }

  async call(): Promise<void> {
    if (this.#state !== 'idle') return;
    this.#isCaller = true;
    if (!(await this.#startMedia())) return;
    this.#setState('outgoing');
    this.control.send({ t: 'ring' });
  }

  async accept(): Promise<void> {
    if (this.#state !== 'incoming') return;
    this.#isCaller = false;
    if (!(await this.#startMedia())) return this.decline();
    await this.#attachLocal();
    this.control.send({ t: 'accept' });
    this.#setState('active');
    this.#announceMedia();
  }

  decline(): void {
    if (this.#state !== 'incoming') return;
    this.control.send({ t: 'decline' });
    this.#setState('idle');
  }

  hangUp(): void {
    if (this.#state === 'idle') return;
    this.control.send({ t: 'hangup' });
    void this.#end(null);
  }

  toggleMic(): void {
    this.#flags = { ...this.#flags, audio: !this.#flags.audio };
    this.#media.setMicEnabled(this.#flags.audio);
    this.#announceMedia();
  }

  async toggleCamera(): Promise<void> {
    const track = await this.#media.setCameraEnabled(!this.#flags.video);
    this.#flags = { ...this.#flags, video: track !== null };
    await this.#slots.replace('video', track);
    void this.#capper.sync();
    this.#emitLocal();
    this.#announceMedia();
  }

  async flipCamera(): Promise<void> {
    if (!this.#flags.video) return;
    await this.#slots.replace('video', await this.#media.flip());
    void this.#capper.sync();
    this.#emitLocal();
  }

  /**
   * Files first (PLAN-FILES-FIRST): while we send files, our camera goes out at most at
   * `MEDIA.filesFirst`, during a call only. Applied in order and again after every track change;
   * `videoCap` reports what is actually applied. Receiving alone never caps.
   */
  setSendingFiles(sending: boolean): Promise<void> {
    return this.#capper.want(sending ? MEDIA.filesFirst : null);
  }

  dispose(): void {
    this.#disposer.dispose();
    this.#media.stop();
  }

  #onRing(): void {
    if (this.#state !== 'idle') {
      this.control.send({ t: 'decline' }); // Already in or setting up a call.
      return;
    }
    this.#setState('incoming');
  }

  async #onAccepted(): Promise<void> {
    if (this.#state !== 'outgoing') return;
    await this.#attachLocal();
    this.#setState('active');
    this.#announceMedia();
  }

  /** The callee's slots appear with the caller's offer; attach our tracks as soon as they exist. */
  async #onRemoteTrack(): Promise<void> {
    if (this.#state === 'active' && !this.#isCaller) await this.#attachLocal();
    if (this.#state === 'active') this.events.emit('remoteStream', this.#slots.remoteStream());
  }

  async #attachLocal(): Promise<void> {
    const tracks: Record<MediaKind, MediaStreamTrack | null> = { audio: this.#media.audio, video: this.#media.video };
    // Start both before awaiting: directions are set synchronously, so a callee answering inside
    // `ontrack` already advertises sendrecv for both and no extra negotiation round is needed.
    await Promise.all((['audio', 'video'] as const).map((kind) => this.#slots.attach(kind, tracks[kind], this.#isCaller)));
    void this.#capper.sync();
    if (this.#slots.ready) this.events.emit('remoteStream', this.#slots.remoteStream());
  }

  async #startMedia(): Promise<boolean> {
    try {
      await this.#media.start();
    } catch (error) {
      this.#isCaller = false;
      this.events.emit('notice', error instanceof MediaError ? error.reason : 'unavailable');
      return false;
    }
    this.#flags = { audio: this.#media.audio !== null, video: this.#media.video !== null };
    this.#emitLocal();
    return true;
  }

  async #end(notice: CallNotice | null): Promise<void> {
    if (this.#state === 'idle') return;
    this.#setState('idle');
    this.#media.stop();
    this.#flags = OFF;
    this.events.emit('localStream', null);
    this.events.emit('remoteStream', null);
    this.events.emit('remoteMedia', OFF);
    if (notice) this.events.emit('notice', notice);
    await this.#slots.park();
    await this.#capper.sync();
  }

  #emitLocal(): void {
    this.events.emit('localStream', this.#media.stream());
    this.events.emit('localMedia', this.#flags);
  }

  #announceMedia(): void {
    this.events.emit('localMedia', this.#flags);
    if (this.#state === 'active') this.control.send({ t: 'media', ...this.#flags });
  }

  #setState(state: CallState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.events.emit('state', state);
    void this.#capper.sync(); // The cap applies only while a call is active: a call started mid-send gets it.
  }
}
