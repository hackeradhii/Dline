import { expect, type Browser, type Page } from '@playwright/test';

/** Two independent browser profiles = two devices. */
export async function twoPeers(browser: Browser): Promise<{ a: Page; b: Page; close: () => Promise<void> }> {
  const ctxA = await browser.newContext({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });
  const ctxB = await browser.newContext({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  return { a, b, close: async () => void (await Promise.all([ctxA.close(), ctxB.close()])) };
}

/** A starts a line, B opens the share link: the default rendezvous pairing. */
export async function pairWithCode(a: Page, b: Page): Promise<void> {
  await a.goto('/');
  await a.getByRole('button', { name: 'Start a line' }).click();
  const link = await a.getByLabel('Or send this link').inputValue();
  expect(link).toMatch(/#r\.[A-Z0-9]{6}$/);
  await b.goto(link);
  await expectConnected(a);
  await expectConnected(b);
}

export async function expectConnected(page: Page): Promise<void> {
  await expect(page.getByText("You're connected")).toBeVisible();
  await expect(page.getByText(/Direct (on the same network|over the internet)/)).toBeVisible();
}

/** Resolves when a <video> is actually rendering frames. */
export async function expectVideoPlaying(page: Page, selector: string): Promise<void> {
  await expect
    .poll(() => page.locator(selector).first().evaluate((v: HTMLVideoElement) => v.videoWidth > 0 && v.readyState >= 2 && !v.paused), { timeout: 20_000 })
    .toBe(true);
}

/**
 * Stages files in A's page first (so Playwright's own upload isn't timed), sends them through the
 * file picker, and returns the seconds until B shows every one of them verified.
 */
export async function timeTransfer(a: Page, b: Page, files: Array<{ name: string; size: number }>, timeoutMs = 120_000): Promise<number> {
  await a.evaluate(async (list) => {
    const transfer = new DataTransfer();
    for (const { name, size } of list) {
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
      transfer.items.add(new File([data], name, { type: 'application/octet-stream' }));
    }
    (window as unknown as { __bench: FileList }).__bench = transfer.files;
  }, files);
  const start = Date.now();
  await a.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    input.files = (window as unknown as { __bench: FileList }).__bench;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  for (const { name } of files) await expect(b.locator('li', { hasText: name }).getByText(/verified with SHA-256/)).toBeVisible({ timeout: timeoutMs });
  return (Date.now() - start) / 1000;
}
