import { defineConfig } from '@playwright/test';
import base, { appServer } from './playwright.config';

/**
 * Benchmarks (not part of `npm run e2e`): raw data-channel lab and app throughput through the
 * network emulator in tests/bench. Host candidates must be real IPs (not mDNS) so the emulator can
 * front them. Always the production build: the dev server reloads the page when a file is saved,
 * which would end a running session.
 */
const { baseURL, webServer } = appServer(true);

export default defineConfig({
  ...base,
  testDir: 'tests/bench',
  timeout: 30 * 60_000,
  webServer,
  use: {
    ...base.use,
    baseURL,
    launchOptions: { args: [...(base.use?.launchOptions?.args ?? []), '--disable-features=WebRtcHideLocalIpsWithMdns'] },
  },
});
