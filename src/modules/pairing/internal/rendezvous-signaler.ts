import { parseMessage } from '../../../contracts/parse';
import type { Signaler } from '../../../contracts/ports';
import { ROOM_SOCKET_PATH } from '../../../contracts/room';
import { InboundSchema, JOIN_PARAMS, type Role, type ServerErrorCode, type Signal } from '../../../contracts/signaling';
import { backoffMs } from '../../../shared/async';
import { SIGNALING } from '../../../shared/config';
import { Emitter, type Unsubscribe } from '../../../shared/emitter';
import { Timeout } from '../../../shared/timer';

export type SocketState = 'connecting' | 'open' | 'closed';

export interface RendezvousEvents {
  joined: { role: Role; peer: boolean };
  presence: boolean;
  signal: Signal;
  error: ServerErrorCode;
  socket: SocketState;
}

export interface RendezvousOptions {
  /** Page origin, e.g. https://dline.example (converted to ws/wss). */
  origin: string;
  code: string;
  /** Host creates the room; guest joins it. */
  create: boolean;
  webSocket?: typeof WebSocket;
  /** Fires when the device regains network (e.g. Wi-Fi → mobile), to reconnect at once. */
  onNetworkChange?: (listener: () => void) => Unsubscribe;
}

/** These end the session; anything else is retried. */
const FATAL: readonly ServerErrorCode[] = ['room-full', 'no-room', 'expired', 'replaced'];

/**
 * WebSocket client for the rendezvous room. Reconnects with backoff and rejoins with its token,
 * so a peer that changed networks can resume and trigger an ICE restart.
 */
export class RendezvousSignaler implements Signaler {
  readonly events = new Emitter<RendezvousEvents>();
  #ws: WebSocket | null = null;
  #token: string | null = null;
  #attempt = 0;
  #closed = false;
  readonly #retry = new Timeout();
  readonly #offNetwork: Unsubscribe;
  readonly #WebSocket: typeof WebSocket;

  constructor(private readonly options: RendezvousOptions) {
    this.#WebSocket = options.webSocket ?? WebSocket;
    this.#offNetwork = options.onNetworkChange?.(() => this.#reconnectNow()) ?? (() => undefined);
  }

  get isConnected(): boolean {
    return this.#ws?.readyState === this.#WebSocket.OPEN && this.#token !== null;
  }

  connect(): void {
    if (this.#closed || this.#ws) return;
    const url = new URL(`${ROOM_SOCKET_PATH}${this.options.code}`, this.options.origin.replace(/^http/, 'ws'));
    if (this.#token) url.searchParams.set(JOIN_PARAMS.token, this.#token);
    else if (this.options.create) url.searchParams.set(JOIN_PARAMS.create, '');

    const ws = new this.#WebSocket(url);
    this.#ws = ws;
    this.events.emit('socket', 'connecting');
    ws.addEventListener('open', () => this.events.emit('socket', 'open'));
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    ws.addEventListener('close', () => this.#onClose(ws));
  }

  send(signal: Signal): boolean {
    if (!this.isConnected) return false;
    this.#ws!.send(JSON.stringify(signal));
    return true;
  }

  onSignal(handler: (signal: Signal) => void): Unsubscribe {
    return this.events.on('signal', handler);
  }

  onPeerPresence(handler: (present: boolean) => void): Unsubscribe {
    return this.events.on('presence', handler);
  }

  close(): void {
    this.#closed = true;
    this.#retry.clear();
    this.#offNetwork();
    this.#ws?.close(1000);
    this.#ws = null;
  }

  #onMessage(raw: unknown): void {
    const message = parseMessage(InboundSchema, raw);
    if (!message) return;
    if (message.t === 'joined') {
      this.#token = message.token;
      this.#attempt = 0;
      this.events.emit('joined', { role: message.role, peer: message.peer });
      if (message.peer) this.events.emit('presence', true);
    } else if (message.t === 'peer') {
      this.events.emit('presence', message.present);
    } else if (message.t === 'error') {
      this.events.emit('error', message.code);
      if (FATAL.includes(message.code)) this.close();
    } else {
      this.events.emit('signal', message);
    }
  }

  #onClose(ws: WebSocket): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.events.emit('socket', 'closed');
    if (this.#closed) return;
    const delay = backoffMs(this.#attempt++, SIGNALING.reconnectBaseMs, SIGNALING.reconnectMaxMs);
    this.#retry.set(() => this.connect(), delay);
  }

  #reconnectNow(): void {
    if (this.#closed) return;
    this.#retry.clear();
    if (this.#ws && this.#ws.readyState !== this.#WebSocket.OPEN) return;
    this.#ws?.close();
    this.#ws = null;
    this.connect();
  }
}
