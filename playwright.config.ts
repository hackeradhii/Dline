import { defineConfig, devices } from '@playwright/test';

/** The app under test: the dev server, or the production build (Worker + Durable Object in workerd). */
export function appServer(preview: boolean) {
  const port = preview ? 4173 : 5173;
  return {
    baseURL: `http://localhost:${port}`,
    webServer: {
      command: preview ? `npx vite build && npx vite preview --port ${port} --strictPort` : `npx vite --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  };
}

/** E2E_PREVIEW=1 runs the suite against the production build. */
const { baseURL, webServer } = appServer(!!process.env.E2E_PREVIEW);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      // Fake camera/mic so calls can be tested headless.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  webServer,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
