import { test } from '@playwright/test';
import { pacingMode, pacingQuery, pairWithCode, startCall, timeTransfer, twoPeers } from './peers';

const MB = 1024 * 1024;
const file = (label: string) => [{ name: `bench-32-${label}-${Date.now()}.bin`, size: 32 * MB }];

/**
 * Measures how long one file takes to arrive verified. Reported, not asserted tightly
 * (machine-dependent). PACING=legacy|shadow|flow picks the file pacing for both pages.
 */
test('throughput with and without a call (localhost)', async ({ browser }) => {
  const { a, b, close } = await twoPeers(browser);
  await pairWithCode(a, b, pacingQuery());
  console.log(`pacing: A ${await pacingMode(a)}, B ${await pacingMode(b)}`);

  for (const label of ['first (cold)', 'second (warm)']) {
    const idle = await timeTransfer(a, b, file(label.split(' ')[0]!));
    console.log(`32 MB, no call, ${label}: ${idle.toFixed(1)} s (${(32 / idle).toFixed(1)} MB/s)`);
  }

  await startCall(a, b);
  const inCall = await timeTransfer(a, b, file('call'));
  console.log(`32 MB, during call: ${inCall.toFixed(1)} s (${(32 / inCall).toFixed(1)} MB/s)`);
  await close();
});
