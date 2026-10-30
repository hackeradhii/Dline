import { test } from '@playwright/test';
import { labPair, mbps, run } from './lab';
import { SCENARIOS } from './netem';

/**
 * Raw RTCDataChannel ceilings, before any app code: lanes (parallel peer connections) × message size,
 * on the direct loopback path and through emulated real-world paths.
 *
 *   LAB=direct,mobile npx playwright test -c playwright.bench.config.ts raw
 */
const wanted = (process.env.LAB ?? 'direct,mobile').split(',');
const KB = 1024;
const MB = 1024 * 1024;

const plans = [
  { key: 'direct', scenario: null, total: 96 * MB, maxMs: 30_000, lanes: [1, 4, 16], chunks: [128 * KB] },
  { key: 'lan', scenario: SCENARIOS.lan, total: 64 * MB, maxMs: 30_000, lanes: [1, 4, 16], chunks: [128 * KB] },
  { key: 'mobile', scenario: SCENARIOS.mobile, total: 512 * MB, maxMs: 15_000, lanes: [1, 2, 4, 8], chunks: [64 * KB, 256 * KB] },
  { key: 'far', scenario: SCENARIOS.far, total: 512 * MB, maxMs: 15_000, lanes: [1, 8, 16], chunks: [256 * KB] },
  { key: 'many', scenario: SCENARIOS.mobile, total: 512 * MB, maxMs: 15_000, lanes: [12, 16], chunks: [256 * KB] },
  { key: 'clean', scenario: SCENARIOS.clean, total: 512 * MB, maxMs: 15_000, lanes: [1, 8], chunks: [256 * KB] },
];

for (const plan of plans.filter((p) => wanted.includes(p.key))) {
  test(`raw lanes: ${plan.key}`, async ({ browser }) => {
    test.setTimeout(30 * 60_000);
    console.log(`\n== ${plan.scenario?.name ?? 'Direct loopback (no emulation)'}`);
    for (const lanes of plan.lanes) {
      for (const chunk of plan.chunks) {
        const pair = await labPair(browser, plan.scenario, lanes);
        try {
          const cold = await run(pair, plan.total, chunk, plan.maxMs);
          const warm = await run(pair, plan.total, chunk, plan.maxMs);
          const loss = pair.netem ? pair.netem.stats().aToB : null;
          const curve = cold.marks.map(([t, b]) => `${(t / 1000).toFixed(0)}s:${(b / MB).toFixed(1)}`).join(' ');
          console.log(
            `lanes ${pair.open}/${lanes}, ${chunk / KB} KB msgs: cold ${mbps(cold).toFixed(2)} MB/s, warm ${mbps(warm).toFixed(2)} MB/s` +
              (loss ? ` | link: ${loss.packets} pkts, ${loss.lost} random loss, ${loss.dropped} queue drops` : '') +
              `\n   cold curve (MB received by second): ${curve}`,
          );
        } finally {
          await pair.close();
        }
      }
    }
  });
}
