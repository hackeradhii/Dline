import type { KeyValueStore } from '../../../contracts/ports';

/** localStorage that never throws (private mode, blocked storage, previews) — falls back to memory. */
export function safeLocalStore(storage: () => Storage = () => globalThis.localStorage): KeyValueStore {
  const memory = new Map<string, string>();
  const attempt = <T>(fn: (s: Storage) => T, fallback: () => T): T => {
    try {
      return fn(storage());
    } catch {
      return fallback();
    }
  };
  return {
    get: (key) => attempt((s) => s.getItem(key), () => memory.get(key) ?? null),
    set: (key, value) => attempt((s) => s.setItem(key, value), () => void memory.set(key, value)),
    remove: (key) => attempt((s) => s.removeItem(key), () => void memory.delete(key)),
  };
}
