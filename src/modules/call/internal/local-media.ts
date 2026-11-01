import type { MediaDevicesPort } from '../../../contracts/ports';
import { MEDIA } from '../../../shared/config';

type Facing = 'user' | 'environment';
export type MediaFailure = 'denied' | 'unavailable';

export class MediaError extends Error {
  constructor(readonly reason: MediaFailure) {
    super(reason === 'denied' ? 'Camera/microphone permission denied' : 'No camera or microphone available');
    this.name = 'MediaError';
  }
}

const isDenied = (e: unknown): boolean => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');

/** Owns the local camera and microphone tracks. Turning the camera off really stops it (light off). */
export class LocalMedia {
  #audio: MediaStreamTrack | null = null;
  #video: MediaStreamTrack | null = null;
  #facing: Facing = 'user';

  constructor(private readonly devices: MediaDevicesPort) {}

  get audio(): MediaStreamTrack | null {
    return this.#audio;
  }

  get video(): MediaStreamTrack | null {
    return this.#video;
  }

  /** A fresh stream object each time, so <video> elements reliably pick up track changes (Safari). */
  stream(): MediaStream | null {
    const tracks = [this.#audio, this.#video].filter((t): t is MediaStreamTrack => t !== null);
    return tracks.length ? new MediaStream(tracks) : null;
  }

  /** Camera + mic; falls back to mic only (and then camera only) if a device is missing. */
  async start(): Promise<void> {
    try {
      const stream = await this.devices.getUserMedia({ audio: MEDIA.audio, video: this.#videoConstraints() });
      this.#audio = stream.getAudioTracks()[0] ?? null;
      this.#video = stream.getVideoTracks()[0] ?? null;
      return;
    } catch (error) {
      if (isDenied(error)) throw new MediaError('denied');
    }
    this.#audio = await this.#acquire('audio');
    this.#video = this.#audio ? null : await this.#acquire('video');
    if (!this.#audio && !this.#video) throw new MediaError('unavailable');
  }

  setMicEnabled(enabled: boolean): void {
    if (this.#audio) this.#audio.enabled = enabled;
  }

  /** Off stops the camera hardware; on opens it again. Returns the new video track (or null). */
  async setCameraEnabled(enabled: boolean): Promise<MediaStreamTrack | null> {
    this.#video?.stop();
    this.#video = enabled ? await this.#acquire('video') : null;
    return this.#video;
  }

  /** Front ↔ back. iOS requires the old track to be stopped before opening the other camera. */
  async flip(): Promise<MediaStreamTrack | null> {
    this.#facing = this.#facing === 'user' ? 'environment' : 'user';
    const track = await this.setCameraEnabled(true);
    if (!track) {
      this.#facing = this.#facing === 'user' ? 'environment' : 'user';
      return this.setCameraEnabled(true);
    }
    return track;
  }

  async cameraCount(): Promise<number> {
    try {
      return (await this.devices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length;
    } catch {
      return 0;
    }
  }

  stop(): void {
    this.#audio?.stop();
    this.#video?.stop();
    this.#audio = null;
    this.#video = null;
  }

  #videoConstraints(): MediaTrackConstraints {
    return { ...MEDIA.video, facingMode: this.#facing };
  }

  async #acquire(kind: 'audio' | 'video'): Promise<MediaStreamTrack | null> {
    try {
      const constraints = kind === 'audio' ? { audio: MEDIA.audio } : { video: this.#videoConstraints() };
      const stream = await this.devices.getUserMedia(constraints);
      return (kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks())[0] ?? null;
    } catch (error) {
      if (isDenied(error)) throw new MediaError('denied');
      return null;
    }
  }
}
