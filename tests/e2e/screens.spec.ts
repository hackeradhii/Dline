import { test } from '@playwright/test';
import { expectVideoPlaying, pairWithCode, twoPeers } from './peers';

/** Captures key screens for visual review (not a pass/fail test). Run with SCREENSHOTS=1. */
test.skip(!process.env.SCREENSHOTS, 'Set SCREENSHOTS=1 to capture screens');

const OUT = 'test-results/screens';

test('capture screens', async ({ browser }) => {
  const { a, b, close } = await twoPeers(browser);
  for (const [scheme, page] of [['light', a], ['dark', b]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await a.goto('/');
  await a.waitForTimeout(3000); // Network check.
  await a.screenshot({ path: `${OUT}/home-mobile-light.png` });
  await b.goto('/');
  await b.waitForTimeout(3000);
  await b.screenshot({ path: `${OUT}/home-mobile-dark.png` });
  await a.setViewportSize({ width: 1280, height: 800 });
  await a.screenshot({ path: `${OUT}/home-desktop-light.png` });
  await a.setViewportSize({ width: 390, height: 844 });

  await a.getByRole('button', { name: 'Start a line' }).click();
  await a.waitForTimeout(500);
  await a.screenshot({ path: `${OUT}/hosting-mobile-light.png`, fullPage: true });
  const link = await a.getByLabel('Or send this link').inputValue();
  await b.goto(link);
  await b.getByText("You're connected").waitFor();
  await a.getByText("You're connected").waitFor();
  await b.screenshot({ path: `${OUT}/room-mobile-dark.png` });
  await a.setViewportSize({ width: 1280, height: 800 });
  await a.screenshot({ path: `${OUT}/room-desktop-light.png` });

  await a.getByRole('button', { name: 'Start video call' }).click();
  await b.getByRole('dialog', { name: 'Incoming video call' }).waitFor();
  await b.screenshot({ path: `${OUT}/incoming-mobile-dark.png` });
  await b.getByRole('button', { name: 'Accept' }).click();
  await expectVideoPlaying(a, 'video:not([muted])');
  await expectVideoPlaying(b, 'video:not([muted])');
  await a.locator('input[type=file]').setInputFiles({ name: 'sunset.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(200_000, 7) });
  await b.waitForTimeout(2000);
  await a.screenshot({ path: `${OUT}/call-desktop-light.png` });
  await b.screenshot({ path: `${OUT}/call-mobile-dark.png`, fullPage: true });
  await a.getByRole('button', { name: 'Connection details' }).click();
  await a.waitForTimeout(500);
  await a.screenshot({ path: `${OUT}/details-desktop-light.png` });
  await close();
});

test('capture ended screen', async ({ browser }) => {
  const { a, b, close } = await twoPeers(browser);
  await b.setViewportSize({ width: 390, height: 844 });
  await pairWithCode(a, b);
  await a.getByRole('button', { name: 'Leave' }).click();
  await b.getByRole('heading', { name: 'They left' }).waitFor();
  await b.screenshot({ path: `${OUT}/ended-mobile-light.png` });
  await close();
});
