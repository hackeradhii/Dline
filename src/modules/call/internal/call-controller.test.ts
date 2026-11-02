import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlEvents, ControlMessage, ControlOf, ControlType } from '../../../contracts/control';
import type { ControlChannel, MediaDevicesPort, TransceiverHost } from '../../../contracts/ports';
import { Emitter, type Unsubscribe } from '../../../shared/emitter';
import { MEDIA } from '../../../shared/config';
import { CallController } from './call-controller';
import type { VideoCap } from './transceiver-slots';

const CAP: VideoCap = MEDIA.filesFirst;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A camera or microphone track of a given size. */
function fakeTrack(kind: 'audio' | 'video', width = 0, height = 0): MediaStreamTrack {
  return { kind, enabled: true, stop: () => undefined, getSettings: () => ({ width, height }) } as unknown as MediaStreamTrack;
}

/** A video sender whose `setParameters` resolves at once, or waits to be resolved or rejected by the test. */
class FakeSender {
  parameters = { encodings: [{}] as RTCRtpEncodingParameters[] } as RTCRtpSendParameters;
  readonly applied: RTCRtpEncodingParameters[] = [];
  readonly waiting: Array<{ resolve: () => void; reject: () => void }> = [];
  auto = true;

  constructor(public track: MediaStreamTrack | null) {}

  getParameters(): RTCRtpSendParameters {
    return structuredClone(this.parameters);
  }

  setParameters(parameters: RTCRtpSendParameters): Promise<void> {
    this.applied.push({ ...parameters.encodings[0] });
    const apply = () => (this.parameters = parameters);
    if (this.auto) {
      apply();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.waiting.push({ resolve: () => (apply(), resolve()), reject: () => reject(new DOMException('no', 'InvalidModificationError')) }));
  }

  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.track = track;
  }

  /** Settles the oldest pending `setParameters`. */
  settle(ok = true): void {
    const next = this.waiting.shift()!;
    if (ok) next.resolve();
    else next.reject();
  }

  get encoding(): RTCRtpEncodingParameters {
    return this.parameters.encodings[0]!;
  }
}

class FakeHost implements TransceiverHost {
  readonly transceivers: Array<{ direction: RTCRtpTransceiverDirection; sender: FakeSender; receiver: { track: { kind: string } } }> = [];
  readonly #track = new Set<(event: RTCTrackEvent) => void>();

  addTransceiver(trackOrKind: MediaStreamTrack | 'audio' | 'video', init: RTCRtpTransceiverInit): RTCRtpTransceiver {
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    const transceiver = { direction: init.direction ?? 'sendrecv', sender: new FakeSender(typeof trackOrKind === 'string' ? null : trackOrKind), receiver: { track: { kind } } };
    this.transceivers.push(transceiver);
    return transceiver as unknown as RTCRtpTransceiver;
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return this.transceivers as unknown as RTCRtpTransceiver[];
  }

  onTrack(handler: (event: RTCTrackEvent) => void): Unsubscribe {
    this.#track.add(handler);
    return () => this.#track.delete(handler);
  }

  fireTrack(): void {
    for (const handler of this.#track) handler({} as RTCTrackEvent);
  }

  get video(): FakeSender {
    return this.transceivers.find((t) => t.receiver.track.kind === 'video')!.sender;
  }
}

class FakeControl implements ControlChannel {
  readonly isOpen = true;
  readonly sent: ControlMessage[] = [];
  readonly #handlers = new Emitter<ControlEvents>();

  send(message: ControlMessage): boolean {
    this.sent.push(message);
    return true;
  }

  on<T extends ControlType>(type: T, handler: (message: ControlOf<T>) => void): Unsubscribe {
    return this.#handlers.on(type, handler);
  }

  deliver(message: ControlMessage): void {
    this.#handlers.emit(message.t, message);
  }
}

/** Cameras that open at these sizes, one after another (the first call, then each flip or re-open). */
function fakeDevices(...videoSizes: Array<[number, number]>): MediaDevicesPort {
  const sizes = [...videoSizes];
  return {
    getUserMedia: async (constraints) => {
      const video = constraints.video ? fakeTrack('video', ...(sizes.shift() ?? [1280, 720])) : null;
      const audio = constraints.audio ? fakeTrack('audio') : null;
      return { getAudioTracks: () => (audio ? [audio] : []), getVideoTracks: () => (video ? [video] : []) } as unknown as MediaStream;
    },
    enumerateDevices: async () => [],
  };
}

/** A call controller with no call yet, recording every cap it reports. */
function idleCall(devices = fakeDevices([1280, 720], [640, 480])) {
  const host = new FakeHost();
  const control = new FakeControl();
  const call = new CallController(control, host, devices);
  const caps: Array<VideoCap | null> = [];
  call.events.on('videoCap', (cap) => caps.push(cap));
  return { call, host, control, caps };
}

/** We call, they accept: an active call with our 1280×720 camera on its slot. */
async function activeCall(devices?: MediaDevicesPort) {
  const parts = idleCall(devices);
  await parts.call.call();
  parts.control.deliver({ t: 'accept' });
  await flush();
  return parts;
}

beforeEach(() => {
  vi.stubGlobal('MediaStream', class {
    constructor(readonly tracks: MediaStreamTrack[] = []) {}
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('CallController: Files first video cap (PLAN-FILES-FIRST FF1)', () => {
  it('caps the video sender through its encoding (no new transceiver), scaled from the track, and reports it only once applied', async () => {
    const { call, host, caps } = await activeCall();
    expect(call.state).toBe('active');
    host.video.auto = false;
    void call.setSendingFiles(true);
    await flush();
    expect(host.video.applied.at(-1)).toMatchObject({ maxBitrate: 500_000, scaleResolutionDownBy: 2 }); // 720 → 360.
    expect(caps).toEqual([]);
    host.video.settle();
    await flush();
    expect(caps).toEqual([CAP]);
    expect(host.transceivers).toHaveLength(2);
  });

  it('lifts it with null: no bitrate ceiling, full size, reported as none', async () => {
    const { call, host, caps } = await activeCall();
    await call.setSendingFiles(true);
    await call.setSendingFiles(false);
    expect(host.video.encoding.maxBitrate).toBeUndefined();
    expect(host.video.encoding.scaleResolutionDownBy).toBe(1);
    expect(caps).toEqual([CAP, null]);
  });

  it('a rejected cap leaves the video uncapped and claims nothing; a later request is still applied (FF1b)', async () => {
    const { call, host, caps } = await activeCall();
    host.video.auto = false;
    void call.setSendingFiles(true);
    await flush();
    host.video.settle(false);
    await flush();
    expect(caps).toEqual([]);
    expect(host.video.encoding.maxBitrate).toBeUndefined();
    host.video.auto = true;
    await call.setSendingFiles(false);
    await call.setSendingFiles(true);
    expect(caps).toEqual([CAP]);
  });

  it('requests made before an update starts coalesce: only the latest is applied', async () => {
    const { call, host, caps } = await activeCall();
    void call.setSendingFiles(true);
    await call.setSendingFiles(false);
    expect(host.video.applied).toHaveLength(0);
    expect(caps).toEqual([]);
  });

  it('cap, then restore while the cap is pending: ends uncapped and reports none (FF1c)', async () => {
    const { call, host, caps } = await activeCall();
    host.video.auto = false;
    void call.setSendingFiles(true);
    await flush(); // The cap is in flight...
    void call.setSendingFiles(false); // ...when the transfer ends.
    host.video.settle();
    await flush();
    host.video.settle();
    await flush();
    expect(host.video.encoding.maxBitrate).toBeUndefined();
    expect(caps.at(-1)).toBeNull();
  });

  it('applied cap → pending restore → new send → restore succeeds → slow re-cap: reports none for the uncapped interval (FF-REVIEW-03)', async () => {
    const { call, host, caps } = await activeCall();
    await call.setSendingFiles(true);
    host.video.auto = false;
    void call.setSendingFiles(false); // The last file finished: the restore is in flight...
    await flush();
    void call.setSendingFiles(true); // ...when another file is queued.
    expect(caps.at(-1)).toBeNull(); // Withdrawn before the change: Flow keeps its full reserve.
    host.video.settle(); // The restore lands: the sender is uncapped.
    await flush();
    expect(host.video.encoding.maxBitrate).toBeUndefined();
    expect(caps.at(-1)).toBeNull();
    host.video.settle(); // The re-cap lands.
    await flush();
    expect(host.video.encoding.maxBitrate).toBe(500_000);
    expect(caps.at(-1)).toBe(CAP);
  });

  it('a camera flipped during a pending update is capped for the new track’s size', async () => {
    const { call, host, caps } = await activeCall(fakeDevices([1280, 720], [640, 480]));
    host.video.auto = false;
    void call.setSendingFiles(true);
    await call.flipCamera(); // The back camera opens at 640×480.
    host.video.settle();
    await flush();
    host.video.settle();
    await flush();
    expect(host.video.encoding.scaleResolutionDownBy).toBeCloseTo(480 / 360, 6);
    expect(caps.at(-1)).toBe(CAP);
  });

  it('overlapping callee track events apply the cap once, in the final state', async () => {
    const { call, host, control, caps } = idleCall(fakeDevices([1280, 720]));
    control.deliver({ t: 'ring' });
    await call.accept(); // Active; our slots arrive with their offer.
    void call.setSendingFiles(true); // No video slot yet: nothing applied.
    await flush();
    expect(caps).toEqual([]);
    host.addTransceiver('audio', { direction: 'recvonly' });
    host.addTransceiver('video', { direction: 'recvonly' });
    host.video.auto = false;
    host.fireTrack();
    host.fireTrack();
    await flush();
    expect(host.video.applied).toHaveLength(1);
    host.video.settle();
    await flush();
    expect(host.video.applied).toHaveLength(1);
    expect(caps).toEqual([CAP]);
  });

  it('a rejected restore is tried again on the next request or call end, so a cap never sticks into later calls (FF-INSPECT-01)', async () => {
    const { call, host, caps } = await activeCall();
    await call.setSendingFiles(true);
    host.video.auto = false;
    void call.setSendingFiles(false);
    await flush();
    host.video.settle(false); // The restore is rejected: the sender keeps its cap.
    await flush();
    expect(host.video.encoding.maxBitrate).toBe(500_000);
    expect(caps.at(-1)).toBeNull(); // Conservative: Flow keeps its full reserve.
    host.video.auto = true;
    await call.setSendingFiles(false); // Another request for no cap: tried again, not skipped.
    expect(host.video.encoding.maxBitrate).toBeUndefined();

    await call.setSendingFiles(true);
    host.video.auto = false;
    void call.setSendingFiles(false);
    await flush();
    host.video.settle(false); // Rejected again...
    await flush();
    host.video.auto = true;
    call.hangUp(); // ...and the call ends: the parked sender is restored for the next call.
    await flush();
    expect(host.video.encoding.maxBitrate).toBeUndefined();
  });

  it('a call started while files are already going out is capped once it is active, for caller and callee', async () => {
    for (const role of ['caller', 'callee'] as const) {
      const { call, host, control, caps } = idleCall(fakeDevices([1280, 720]));
      await call.setSendingFiles(true); // No call yet: nothing to cap.
      expect(caps).toEqual([]);
      if (role === 'caller') {
        await call.call();
        control.deliver({ t: 'accept' });
      } else {
        host.addTransceiver('audio', { direction: 'recvonly' });
        host.addTransceiver('video', { direction: 'recvonly' });
        control.deliver({ t: 'ring' });
        await call.accept();
      }
      await flush();
      expect(call.state).toBe('active');
      expect(host.video.encoding.maxBitrate).toBe(CAP.maxBitrateBps);
      expect(caps).toEqual([CAP]);
    }
  });

  it('is lifted when the call ends', async () => {
    const { call, host, caps } = await activeCall();
    await call.setSendingFiles(true);
    call.hangUp();
    await flush();
    expect(host.video.encoding.maxBitrate).toBeUndefined();
    expect(caps.at(-1)).toBeNull();
  });
});
