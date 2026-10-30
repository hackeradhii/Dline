import { ROOM } from '../shared/config';
import { randomString } from '../shared/bytes';

/** Room codes: shared by the client (create/validate) and the Worker (routing). */

const CODE_PATTERN = new RegExp(`^[${ROOM.alphabet}]{${ROOM.length}}$`);

export function createRoomCode(): string {
  return randomString(ROOM.length, ROOM.alphabet);
}

/** Accepts user input like "k7m-q2p" and returns "K7MQ2P", or null if it can't be a code. */
export function normalizeRoomCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}

/** "K7MQ2P" → "K7M-Q2P" for display. */
export function displayRoomCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

export const ROOM_SOCKET_PATH = '/ws/';
