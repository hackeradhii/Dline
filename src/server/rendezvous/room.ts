import { DurableObject } from 'cloudflare:workers';
import { parseMessage } from '../../contracts/parse';
import { JOIN_PARAMS, SERVER_ERRORS, SignalSchema, type Role, type ServerErrorCode, type ServerEvent } from '../../contracts/signaling';
import { ROOM } from '../../shared/config';
import { randomId } from '../../shared/bytes';

/**
 * One Durable Object per room code. It only swaps the WebRTC handshake (SDP/ICE) between the two
 * peers; media and files never touch it. It keeps two random reconnect tokens so a peer that changed
 * networks can rejoin and run an ICE restart, and deletes everything when the room expires.
 */

interface RoomRecord {
  hostToken: string;
  guestToken: string | null;
  createdAt: number;
  emptySince: number | null;
}

interface Attachment {
  role: Role;
}

const RECORD_KEY = 'room';
const OTHER: Record<Role, Role> = { host: 'guest', guest: 'host' };
/** Close codes: 4000 + index keeps them in the application range. */
const closeCode = (code: ServerErrorCode): number => 4000 + SERVER_ERRORS.indexOf(code);

type Assignment = { role: Role; token: string; record: RoomRecord } | { error: ServerErrorCode };

export class RendezvousRoom extends DurableObject<Env> {
  /** Per-socket message counters; resetting on hibernation is fine. */
  readonly #rates = new WeakMap<WebSocket, { count: number; windowStart: number }>();

  override async fetch(request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    const params = new URL(request.url).searchParams;
    const assignment = this.#assign(await this.#record(), params.has(JOIN_PARAMS.create), params.get(JOIN_PARAMS.token));

    if ('error' in assignment) {
      server.accept();
      this.#reject(server, assignment.error);
      return new Response(null, { status: 101, webSocket: client });
    }

    const { role, token, record } = assignment;
    for (const old of this.ctx.getWebSockets(role)) this.#reject(old, 'replaced');

    record.emptySince = null;
    await this.ctx.storage.put(RECORD_KEY, record);
    await this.#scheduleCheck();

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role } satisfies Attachment);
    const peerPresent = this.#sockets(OTHER[role]).length > 0;
    this.#send(server, { t: 'joined', role, token, peer: peerPresent });
    this.#broadcast(OTHER[role], { t: 'peer', present: true });
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.#withinRate(ws)) return this.#reject(ws, 'rate-limited');
    const tooBig = typeof message !== 'string' || message.length > ROOM.maxMessageBytes;
    const signal = tooBig ? null : parseMessage(SignalSchema, message);
    if (!signal) return this.#send(ws, { t: 'error', code: 'bad-request' });
    const { role } = ws.deserializeAttachment() as Attachment;
    // Re-serialize the validated value so nothing unvalidated is ever forwarded.
    for (const peer of this.#sockets(OTHER[role])) peer.send(JSON.stringify(signal));
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.#onSocketGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.#onSocketGone(ws);
  }

  override async alarm(): Promise<void> {
    const record = await this.#record();
    const now = Date.now();
    const expired =
      !record ||
      now - record.createdAt > ROOM.maxLifetimeMs ||
      (!record.guestToken && now - record.createdAt > ROOM.unpairedTtlMs) ||
      (record.emptySince !== null && now - record.emptySince > ROOM.idleTtlMs);
    if (!expired) return this.#scheduleCheck();
    for (const ws of this.ctx.getWebSockets()) this.#reject(ws, 'expired');
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  #assign(record: RoomRecord | undefined, create: boolean, token: string | null): Assignment {
    if (token) {
      if (record?.hostToken === token) return { role: 'host', token, record };
      if (record?.guestToken === token) return { role: 'guest', token, record };
      return { error: 'expired' };
    }
    if (create) {
      if (record) return { error: 'room-full' };
      const hostToken = randomId();
      return { role: 'host', token: hostToken, record: { hostToken, guestToken: null, createdAt: Date.now(), emptySince: null } };
    }
    if (!record) return { error: 'no-room' };
    if (record.guestToken) return { error: 'room-full' };
    const guestToken = randomId();
    return { role: 'guest', token: guestToken, record: { ...record, guestToken } };
  }

  async #onSocketGone(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    this.#broadcast(OTHER[attachment.role], { t: 'peer', present: false });
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    const record = await this.#record();
    if (record && remaining.length === 0) {
      record.emptySince = Date.now();
      await this.ctx.storage.put(RECORD_KEY, record);
    }
  }

  #record(): Promise<RoomRecord | undefined> {
    return this.ctx.storage.get<RoomRecord>(RECORD_KEY);
  }

  async #scheduleCheck(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + Math.min(ROOM.unpairedTtlMs, ROOM.idleTtlMs));
  }

  #sockets(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(role).filter((s) => s.readyState === WebSocket.OPEN);
  }

  #broadcast(role: Role, event: ServerEvent): void {
    for (const ws of this.#sockets(role)) this.#send(ws, event);
  }

  #send(ws: WebSocket, event: ServerEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // Socket went away; close handling cleans up.
    }
  }

  #reject(ws: WebSocket, code: ServerErrorCode): void {
    this.#send(ws, { t: 'error', code });
    try {
      ws.close(closeCode(code), code);
    } catch {
      // Already closed.
    }
  }

  #withinRate(ws: WebSocket): boolean {
    const now = Date.now();
    const rate = this.#rates.get(ws);
    if (!rate || now - rate.windowStart > ROOM.rateWindowMs) {
      this.#rates.set(ws, { count: 1, windowStart: now });
      return true;
    }
    rate.count++;
    return rate.count <= ROOM.maxMessagesPerWindow;
  }
}
