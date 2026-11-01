import { test } from '@playwright/test';
import { labPair, mbps, run } from './lab';
import { QueueSampler } from './measure';
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
  { key: 'cell-up', scenario: SCENARIOS['cell-up'], total: 64 * MB, maxMs: 15_000, lanes: [1, 4, 16], chunks: [256 * KB] },
];

for (const plan of plans.filter((p) => wanted.includes(p.key))) {
  test(`raw lanes: ${plan.key}`, async ({ browser }) => {
    test.setTimeout(30 * 60_000);
    console.log(`\n== ${plan.scenario?.name ?? 'Direct loopback (no emulation)'}`);
    for (const lanes of plan.lanes) {
      for (const chunk of plan.chunks) {
        const pair = await labPair(browser, plan.scenario, lanes);
        const queue = pair.netem ? new QueueSampler(pair.netem) : null;
        try {
          const cold = await run(pair, plan.total, chunk, plan.maxMs);
          const warm = await run(pair, plan.total, chunk, plan.maxMs);
          const loss = pair.netem ? pair.netem.stats().aToB : null;
          const q = queue?.stop().aToB;
          const curve = cold.marks.map(([t, b]) => `${(t / 1000).toFixed(0)}s:${(b / MB).toFixed(1)}`).join(' ');
          console.log(
            `lanes ${pair.open}/${lanes}, ${chunk / KB} KB msgs: cold ${mbps(cold).toFixed(2)} MB/s, warm ${mbps(warm).toFixed(2)} MB/s` +
              (loss ? ` | link: ${loss.packets} pkts, ${loss.lost} random loss, ${loss.dropped} queue drops` : '') +
              (q ? ` | queue a→b p50 ${q.p50.toFixed(0)} ms, p95 ${q.p95.toFixed(0)} ms, max ${q.max.toFixed(0)} ms` : '') +
              `\n   cold curve (MB received by second): ${curve}`,
          );
        } finally {
          queue?.stop();
          await pair.close();
        }
      }
    }
  });
}
