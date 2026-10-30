import { test, type Browser } from '@playwright/test';
import { pairWithCode, timeTransfer } from '../e2e/peers';
import { Netem, SCENARIOS, type Scenario } from './netem';
import { connectedPeers, routeThrough } from './shim';

/**
 * Dline itself (not the raw lab) through emulated real-world paths: one big video, then a batch of
 * photos. Run before and after a change to compare.
 *
 *   BENCH=mobile,far npx playwright test -c playwright.bench.config.ts app
 */
const MB = 1024 * 1024;
const wanted = (process.env.BENCH ?? 'lan,mobile,far,clean').split(',');
const cases = [
  { key: 'lan', scenario: SCENARIOS.lan, videoMb: 64, photos: 20 },
  { key: 'mobile', scenario: SCENARIOS.mobile, videoMb: 16, photos: 10 },
  { key: 'far', scenario: SCENARIOS.far, videoMb: 8, photos: 6 },
  { key: 'clean', scenario: SCENARIOS.clean, videoMb: 8, photos: 4 },
];

async function routedPeers(browser: Browser, scenario: Scenario) {
  const netem = new Netem(scenario);
  const context = async (side: 'a' | 'b') => {
    const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
    await routeThrough(ctx, side, netem);
    return ctx;
  };
  const [ctxA, ctxB] = await Promise.all([context('a'), context('b')]);
  const [a, b] = await Promise.all([ctxA.newPage(), ctxB.newPage()]);
  // A broken run should say why: page errors, crashes and warnings from either side.
  for (const [side, page] of [['a', a], ['b', b]] as const) {
    page.on('pageerror', (e) => console.log(`[${side}] page error: ${e.message}`));
    page.on('crash', () => console.log(`[${side}] crashed`));
    page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log(`[${side}] ${m.type()}: ${m.text()}`));
  }
  return {
    a,
    b,
    netem,
    close: async () => {
      await Promise.all([ctxA.close(), ctxB.close()]);
      await netem.close();
    },
  };
}

for (const c of cases.filter((x) => wanted.includes(x.key))) {
  test(`app throughput: ${c.key}`, async ({ browser }) => {
    test.setTimeout(15 * 60_000);
    const { a, b, netem, close } = await routedPeers(browser, c.scenario);
    try {
      await pairWithCode(a, b);
      await a.waitForTimeout(3_000); // Same settling time for every version (e.g. extra paths opening).
      const video = await timeTransfer(a, b, [{ name: `video-${c.videoMb}mb.bin`, size: c.videoMb * MB }], 600_000);
      const photos = Array.from({ length: c.photos }, (_, i) => ({ name: `photo-${String(i).padStart(2, '0')}.jpg`, size: MB }));
      const batch = await timeTransfer(a, b, photos, 600_000);
      const link = netem.stats().aToB;
      const peers = await connectedPeers(a);
      console.log(
        `\n== ${c.scenario.name}\n` +
          `${c.videoMb} MB video: ${video.toFixed(1)} s (${(c.videoMb / video).toFixed(2)} MB/s)\n` +
          `${c.photos} × 1 MB photos: ${batch.toFixed(1)} s (${(c.photos / batch).toFixed(2)} MB/s)\n` +
          `connections at the end: ${peers}
` +
          `link a→b: ${link.packets} packets, ${link.lost} random loss, ${link.dropped} queue drops`,
      );
    } finally {
      await close();
    }
  });
}
