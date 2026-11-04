import type { KeyValueStore } from '../../../contracts/ports';
import { STORAGE_KEYS } from '../../../shared/config';

/** Sharing performance reports (numbers only), ON by default; the user can turn it off in Settings. */
export class MetricsSettings {
  constructor(private readonly store: KeyValueStore) {}

  load(): boolean {
    return this.store.get(STORAGE_KEYS.metrics) !== 'off';
  }

  save(enabled: boolean): void {
    this.store.set(STORAGE_KEYS.metrics, enabled ? 'on' : 'off');
  }
}
