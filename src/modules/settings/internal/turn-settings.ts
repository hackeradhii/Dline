import * as v from 'valibot';
import type { KeyValueStore } from '../../../contracts/ports';
import { STORAGE_KEYS, STUN_URLS } from '../../../shared/config';

/**
 * Optional TURN relay, OFF by default. When on, traffic may be relayed (still encrypted) and the UI
 * says "Relayed · NOT P2P". Credentials are entered by the user and stay on this device.
 */

const TurnSchema = v.object({
  enabled: v.boolean(),
  urls: v.array(v.pipe(v.string(), v.regex(/^turns?:[^\s]+$/))),
  username: v.string(),
  credential: v.string(),
});
export type TurnConfig = v.InferOutput<typeof TurnSchema>;

export const DEFAULT_TURN: TurnConfig = { enabled: false, urls: [], username: '', credential: '' };

export class TurnSettings {
  constructor(private readonly store: KeyValueStore) {}

  load(): TurnConfig {
    const raw = this.store.get(STORAGE_KEYS.turn);
    if (!raw) return DEFAULT_TURN;
    try {
      const parsed = v.safeParse(TurnSchema, JSON.parse(raw));
      return parsed.success ? parsed.output : DEFAULT_TURN;
    } catch {
      return DEFAULT_TURN;
    }
  }

  /** Validates and saves. Returns the problem as text if the config is unusable. */
  save(config: TurnConfig): string | null {
    const parsed = v.safeParse(TurnSchema, config);
    if (!parsed.success) return 'TURN URLs must start with turn: or turns:';
    if (config.enabled && config.urls.length === 0) return 'Add at least one TURN URL, or turn the relay off';
    this.store.set(STORAGE_KEYS.turn, JSON.stringify(parsed.output));
    return null;
  }

  clear(): void {
    this.store.remove(STORAGE_KEYS.turn);
  }
}

/** STUN only: finds direct paths, can never relay. */
export function directIceServers(): RTCIceServer[] {
  return [{ urls: [...STUN_URLS] }];
}

/** STUN always; TURN only when the user switched it on. */
export function iceServersFor(turn: TurnConfig): RTCIceServer[] {
  const servers = directIceServers();
  if (turn.enabled && turn.urls.length) servers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
  return servers;
}
