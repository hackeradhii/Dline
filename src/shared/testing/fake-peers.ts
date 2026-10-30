import type { PeerFactory } from '../../contracts/ports';
import { asChannel, FakeDataChannel } from './fake-channels';

/**
 * Just enough RTCPeerConnection for in-band negotiation tests: applying an offer pairs two fakes,
 * applying the answer connects them, and their negotiated data channels (same id) open, twinned.
 */
export class FakePeer extends EventTarget {
  static readonly #offers = new Map<string, FakePeer>();
  static #count = 0;

  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  readonly sctp = { maxMessageSize: 256 * 1024 } as RTCSctpTransport;
  readonly candidates: RTCIceCandidateInit[] = [];
  readonly #channels = new Map<number, FakeDataChannel>();
  #partner: FakePeer | null = null;

  constructor(readonly config: RTCConfiguration) {
    super();
  }

  createDataChannel(label: string, init: RTCDataChannelInit = {}): RTCDataChannel {
    const channel = new FakeDataChannel(label);
    this.#channels.set(init.id ?? -1, channel);
    return asChannel(channel);
  }

  async setLocalDescription(): Promise<void> {
    if (this.remoteDescription?.type === 'offer') {
      this.localDescription = { type: 'answer', sdp: this.remoteDescription.sdp ?? '' };
    } else {
      const token = `fake-offer-${++FakePeer.#count}`;
      FakePeer.#offers.set(token, this);
      this.localDescription = { type: 'offer', sdp: token };
    }
    setTimeout(() => this.#announceCandidate()); // Gathering finishes after the description is set, as in browsers.
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    const token = description.sdp ?? '';
    if (description.type === 'offer') {
      const offerer = FakePeer.#offers.get(token);
      if (offerer) {
        this.#partner = offerer;
        offerer.#partner = this;
      }
    } else if (description.type === 'answer' && this.#partner) {
      FakePeer.#offers.delete(token);
      this.#connect(this.#partner);
    }
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void> {
    if (candidate) this.candidates.push(candidate);
  }

  close(): void {
    this.connectionState = 'closed';
    for (const channel of this.#channels.values()) channel.close();
  }

  /** Test hook: the path breaks. */
  setState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  #connect(other: FakePeer): void {
    for (const [id, mine] of this.#channels) {
      const theirs = other.#channels.get(id);
      if (!theirs) continue;
      mine.twin = theirs;
      theirs.twin = mine;
      queueMicrotask(() => {
        mine.open();
        theirs.open();
      });
    }
    this.setState('connected');
    other.setState('connected');
  }

  #announceCandidate(): void {
    const candidate = { toJSON: () => ({ candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 }) };
    this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate }));
  }
}

/** A PeerFactory that records the fakes it makes. */
export function fakePeerFactory(): PeerFactory & { peers: FakePeer[] } {
  const peers: FakePeer[] = [];
  return {
    peers,
    create(config) {
      const peer = new FakePeer(config);
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
  };
}
