import { defineConfig } from '@playwright/test';
import base, { appServer } from './playwright.config';
import { FAKE_VIDEO } from './tests/bench/fake-video';

/**
 * Benchmarks (not part of `npm run e2e`): raw data-channel lab and app throughput through the
 * network emulator in tests/bench. Host candidates must be real IPs (not mDNS) so the emulator can
 * front them. Always the production build: the dev server reloads the page when a file is saved,
 * which would end a running session.
 *
 * The fake camera plays generated noise (tests/bench/fake-video.ts) so calls load the encoder like
 * a real camera. Each app run appends a line to test-results/bench-results.jsonl, which survives
 * bench runs: Playwright's own output goes to test-results/bench, the folder it clears.
 */
const { baseURL, webServer } = appServer(true);

// One id per invocation: every result line carries it, and the closing summary covers just this run.
process.env.BENCH_RUN ??= new Date().toISOString();

export default defineConfig({
  ...base,
  testDir: 'tests/bench',
  outputDir: 'test-results/bench',
  globalSetup: './tests/bench/fake-video.ts',
  globalTeardown: './tests/bench/results.ts',
  timeout: 30 * 60_000,
  webServer,
  use: {
    ...base.use,
    baseURL,
    launchOptions: {
      args: [...(base.use?.launchOptions?.args ?? []), '--disable-features=WebRtcHideLocalIpsWithMdns', `--use-file-for-fake-video-capture=${FAKE_VIDEO}`],
    },
  },
});
