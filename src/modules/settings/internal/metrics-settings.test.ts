import { describe, expect, it } from 'vitest';
import { MetricsSettings } from './metrics-settings';
import { safeLocalStore } from './local-store';

const memoryStore = () =>
  safeLocalStore(() => {
    throw new Error('no storage');
  });

describe('MetricsSettings', () => {
  it('is on until the user turns it off, and remembers the choice', () => {
    const store = memoryStore();
    const settings = new MetricsSettings(store);
    expect(settings.load()).toBe(true);
    settings.save(false);
    expect(new MetricsSettings(store).load()).toBe(false);
    settings.save(true);
    expect(settings.load()).toBe(true);
  });
});
