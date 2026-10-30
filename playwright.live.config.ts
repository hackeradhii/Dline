import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Runs the e2e suite against the deployed site: LIVE_URL=https://… npx playwright test -c playwright.live.config.ts */
export default defineConfig({
  ...base,
  webServer: undefined,
  use: { ...base.use, baseURL: process.env.LIVE_URL ?? 'https://dline.adhi-dev.workers.dev' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
