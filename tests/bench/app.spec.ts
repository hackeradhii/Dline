import { expect, test, type Browser, type Page } from '@playwright/test';
import { pacingMode, pacingQuery, pairWithCode, startCall, timeTransfer } from '../e2e/peers';
import { PageProbe, QueueSampler, callOk, type CallSpan } from './measure';
import { Netem, SCENARIOS, type Scenario } from './netem';
import { appendResult, TRACES, type TimelineSecond } from './results';
import { connectedPeers, routeThrough } from './shim';

/**
 * Dline itself (not the raw lab) through emulated real-world paths: one big video, then a batch of
 * photos, a → b. Run before and after a change and compare medians.
 *
 *   BENCH=mobile,far npx playwright test -c playwright.bench.config.ts app
 *   BENCH=cell-up CALL=1 PACING=flow npx playwright test -c playwright.bench.config.ts app --repeat-each 3
 *
 * CALL=1 holds a video call during the transfer: 10 s of the call alone first, as the baseline
 * for "call OK" in each direction. PACING=legacy|shadow|flow picks the file pacing on both pages
 * (unset: the build's default). Every run appends to test-results/bench-results.jsonl, with a
 * second-by-second timeline of the transfer; TIMELINE=1 prints it too. UPLINK_MBIT=4 narrows a's
 * uplink (a → b) to match a field measurement; such runs are labelled e.g. `cell-up@4M`. TRACE=1
 * opens the pages with `?debug=1` and saves A's Flow trace ("Save trace") after the transfer, to
 * test-results/bench-traces/.
 */
const MB = 1024 * 1024;
/** A new call's video takes ~20 s to ramp up to its ceiling (bandwidth estimation starts low). */
const CALL_WARMUP_MS = 20_000;
const CALL_ALONE_MS = 10_000;
const wanted = (process.env.BENCH ?? 'lan,mobile,far,clean').split(',');
const withCall = process.env.CALL === '1';
const traced = process.env.TRACE === '1';
const uplinkMbit = process.env.UPLINK_MBIT ? Number(process.env.UPLINK_MBIT) : null;
const cases = [
  { key: 'lan', scenario: SCENARIOS.lan, videoMb: 64, photos: 20 },
  { key: 'mobile', scenario: SCENARIOS.mobile, videoMb: 16, photos: 10 },
  { key: 'far', scenario: SCENARIOS.far, videoMb: 8, photos: 6 },
  { key: 'clean', scenario: SCENARIOS.clean, videoMb: 8, photos: 4 },
  { key: 'cell-up', scenario: SCENARIOS['cell-up'], videoMb: 16, photos: 4 },
  { key: 'cell-down', scenario: SCENARIOS['cell-down'], videoMb: 16, photos: 4 },
  { key: 'cell-var', scenario: SCENARIOS['cell-var'], videoMb: 16, photos: 4 },
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

const ms = (value: number) => `${value.toFixed(0)} ms`;

/** Saves the page's Flow trace the way a person would: "Save trace" in the connection details (needs `?debug=1`). */
async function saveTrace(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: 'Connection details' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save trace' }).click();
  // The run id is an ISO time unless BENCH_RUN names it, and Windows file names can't hold its colons.
  const run = (process.env.BENCH_RUN ?? 'bench').replace(/[^\w.-]+/g, '-');
  const file = `${TRACES}/${run}-${name}.json`;
  await (await download).saveAs(file);
  return file;
}

/** The case as run: its scenario, with a's uplink narrowed if UPLINK_MBIT asks for it. */
function asRun(c: (typeof cases)[number]): { key: string; scenario: Scenario } {
  if (uplinkMbit === null) return c;
  const aToB = { ...c.scenario.aToB, rateBitsPerSecond: uplinkMbit * 1e6, rateSchedule: undefined };
  return { key: `${c.key}@${uplinkMbit}M`, scenario: { ...c.scenario, name: `${c.scenario.name}, uplink narrowed to ${uplinkMbit} Mbit/s`, aToB } };
}

/** Second by second: the a → b link, its deepest queue, and what A itself reads (round trip, inbound loss, video sent). */
const describeTimeline = (timeline: TimelineSecond[]) =>
  ['  s  link Mbit/s  queue ms  A rtt ms  A loss %  A video Mbit/s']
    .concat(
      timeline.map(
        (s) =>
          `${String(s.t).padStart(3)}  ${s.linkMbps.toFixed(2).padStart(11)}  ${s.queueMs.toFixed(0).padStart(8)}  ${(s.rttMs?.toFixed(0) ?? '-').padStart(8)}  ` +
          `${(s.lossPercent?.toFixed(1) ?? '-').padStart(8)}  ${s.videoMbps.toFixed(2).padStart(14)}`,
      ),
    )
    .join('\n');

for (const c of cases.filter((x) => wanted.includes(x.key))) {
  const { key, scenario } = asRun(c);
  test(`app throughput: ${key}${withCall ? ', during a call' : ''}`, async ({ browser }) => {
    test.setTimeout(15 * 60_000);
    const { a, b, netem, close } = await routedPeers(browser, scenario);
    try {
      await pairWithCode(a, b, pacingQuery(undefined, traced));
      const modes = await Promise.all([pacingMode(a), pacingMode(b)]);
      if (process.env.PACING) expect(modes, 'pacing mode on A and B').toEqual([process.env.PACING, process.env.PACING]);
      const probe = await PageProbe.start(a, b);
      if (withCall) await startCall(a, b);
      await a.waitForTimeout(3_000); // Same settling time for every version (e.g. extra paths opening).
      let alone: CallSpan | null = null;
      if (withCall) {
        await a.waitForTimeout(CALL_WARMUP_MS);
        const from = await probe.mark();
        await a.waitForTimeout(CALL_ALONE_MS);
        alone = await probe.span(from, await probe.mark());
      }

      const queue = new QueueSampler(netem);
      const sending = await probe.mark();
      const video = await timeTransfer(a, b, [{ name: `video-${c.videoMb}mb.bin`, size: c.videoMb * MB }], 600_000);
      const photos = Array.from({ length: c.photos }, (_, i) => ({ name: `photo-${String(i).padStart(2, '0')}.jpg`, size: MB }));
      const batch = await timeTransfer(a, b, photos, 600_000);
      const sent = await probe.mark();
      const during = alone ? await probe.span(sending, sent) : null;
      const queueMs = queue.stop();
      const views = await probe.seconds('a', sending, sent);
      const timeline: TimelineSecond[] = queue.seconds.map((link, t) => ({
        t,
        linkMbps: link.aToB.mbps,
        queueMs: link.aToB.queueMaxMs,
        ...(views[t] ?? { rttMs: null, lossPercent: null, videoMbps: 0 }),
      }));

      const bytes = (c.videoMb + c.photos) * MB;
      const link = netem.stats();
      const peers = await connectedPeers(a);
      const trace = traced ? { file: await saveTrace(a, `${key}${withCall ? '-call' : ''}-${test.info().repeatEachIndex}`), sendingAtMs: sending.a } : null;
      appendResult({
        scenario: key,
        call: withCall,
        pacing: modes[0],
        linkBitsPerSecond: scenario.aToB.rateBitsPerSecond,
        files: { bytes, seconds: video + batch, bitsPerSecond: (bytes * 8) / (video + batch) },
        queueMs,
        link,
        connections: peers,
        timeline,
        ...(alone && during ? { video: { alone, during, ok: { aToB: callOk(alone.aToB, during.aToB), bToA: callOk(alone.bToA, during.bToA) } } } : {}),
        ...(trace ? { trace } : {}),
      });
      console.log(
        `\n== ${scenario.name}${withCall ? ', during a call' : ''} (pacing: ${modes[0] ?? 'pre-flow build'})\n` +
          `${c.videoMb} MB video: ${video.toFixed(1)} s (${(c.videoMb / video).toFixed(2)} MB/s)\n` +
          `${c.photos} × 1 MB photos: ${batch.toFixed(1)} s (${(c.photos / batch).toFixed(2)} MB/s)\n` +
          `queue a→b p50 ${ms(queueMs.aToB.p50)}, p95 ${ms(queueMs.aToB.p95)}, max ${ms(queueMs.aToB.max)}; b→a p95 ${ms(queueMs.bToA.p95)}\n` +
          (alone && during
            ? (['aToB', 'bToA'] as const)
                .map(
                  (d) =>
                    `video ${d}: ${(during[d].bitrate / 1e6).toFixed(2)} Mbit/s, ${during[d].height}p at ${during[d].fps.toFixed(0)} fps, frozen ${during[d].freezeSecondsPerMinute.toFixed(1)} s/min ` +
                    `(alone: ${(alone[d].bitrate / 1e6).toFixed(2)} Mbit/s, ${alone[d].height}p at ${alone[d].fps.toFixed(0)} fps)\n`,
                )
                .join('')
            : '') +
          `connections at the end: ${peers}\n` +
          `link a→b: ${link.aToB.packets} packets, ${link.aToB.lost} random loss, ${link.aToB.dropped} queue drops` +
          (process.env.TIMELINE === '1' ? `\n${describeTimeline(timeline)}` : ''),
      );
    } finally {
      await close();
    }
  });
}
