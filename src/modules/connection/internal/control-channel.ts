import { ControlSchema, type ControlEvents, type ControlMessage, type ControlOf, type ControlType } from '../../../contracts/control';
import { parseMessage } from '../../../contracts/parse';
import type { ControlChannel } from '../../../contracts/ports';
import { Emitter, type Unsubscribe } from '../../../shared/emitter';

/**
 * Typed `ctrl` channel. Incoming messages are validated, then dispatched through a registry keyed
 * by message type, so new message kinds are added by registering a handler (open/closed).
 */
export class DataControlChannel implements ControlChannel {
  #channel: RTCDataChannel | null = null;
  readonly #handlers = new Emitter<ControlEvents>();
  readonly events = new Emitter<{ open: undefined; close: undefined; message: ControlMessage }>();

  get isOpen(): boolean {
    return this.#channel?.readyState === 'open';
  }

  attach(channel: RTCDataChannel): void {
    this.#channel = channel;
    channel.addEventListener('open', () => this.events.emit('open', undefined));
    channel.addEventListener('close', () => this.events.emit('close', undefined));
    channel.addEventListener('message', (event) => this.#dispatch(event.data));
    if (channel.readyState === 'open') this.events.emit('open', undefined);
  }

  send(message: ControlMessage): boolean {
    if (!this.isOpen) return false;
    try {
      this.#channel!.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  on<T extends ControlType>(type: T, handler: (message: ControlOf<T>) => void): Unsubscribe {
    return this.#handlers.on(type, handler);
  }

  close(): void {
    this.#channel?.close();
    this.#handlers.clear();
  }

  #dispatch(raw: unknown): void {
    const message = parseMessage(ControlSchema, raw);
    if (!message) return; // Unknown or malformed: ignored by design.
    this.events.emit('message', message);
    this.#handlers.emit(message.t, message);
  }
}
