import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { expectConnected, expectVideoPlaying, pairWithCode, twoPeers } from './peers';

test.describe('two devices', () => {
  test('pair with a room code and show a direct path', async ({ browser }) => {
    const { a, b, close } = await twoPeers(browser);
    await pairWithCode(a, b);

    await a.getByRole('button', { name: 'Connection details' }).click();
    const details = a.getByRole('dialog', { name: 'Connection' });
    await expect(details.getByText(/Peer-to-peer: 0 bytes have gone through any relay/)).toBeVisible();
    await expect(details.getByText('Room code (handshake via rendezvous)')).toBeVisible();
    // Both sides derive the same safety words from the two DTLS fingerprints.
    const wordsA = await details.locator('p.text-xl').innerText();
    await b.getByRole('button', { name: 'Connection details' }).click();
    const wordsB = await b.getByRole('dialog', { name: 'Connection' }).locator('p.text-xl').innerText();
    expect(wordsA.split(' ')).toHaveLength(4);
    expect(wordsA).toBe(wordsB);
    await close();
  });

  test('pair with two links and no server at all', async ({ browser }) => {
    const { a, b, close } = await twoPeers(browser);
    await a.goto('/');
    await a.getByRole('button', { name: /Pair with links instead/ }).click();
    const invite = a.getByLabel('Invite link');
    await expect(invite).toHaveValue(/#o\.c/);
    const inviteUrl = await invite.inputValue();
    expect(inviteUrl.length).toBeLessThan(400);

    await b.goto(inviteUrl);
    const reply = b.getByLabel('Reply link');
    await expect(reply).toHaveValue(/#a\.c/);
    await a.getByLabel('Reply link').fill(await reply.inputValue());
    await a.getByRole('button', { name: 'Connect' }).click();

    await expectConnected(a);
    await expectConnected(b);
    await a.getByRole('button', { name: 'Connection details' }).click();
    await expect(a.getByText('Links only (no server at all)')).toBeVisible();
    await close();
  });

  test('video call: ring, accept, see each other, camera off, hang up', async ({ browser }) => {
    const { a, b, close } = await twoPeers(browser);
    await pairWithCode(a, b);

    await a.getByRole('button', { name: 'Start video call' }).click();
    const ringing = b.getByRole('dialog', { name: 'Incoming video call' });
    await expect(ringing).toBeVisible();
    await ringing.getByRole('button', { name: 'Accept' }).click();

    await expectVideoPlaying(a, 'video:not([muted])');
    await expectVideoPlaying(b, 'video:not([muted])');

    await b.getByRole('button', { name: 'Turn camera off' }).click();
    await expect(a.getByText('Their camera is off')).toBeVisible();
    await b.getByRole('button', { name: 'Turn camera on' }).click();
    await expect(a.getByText('Their camera is off')).toBeHidden();

    await a.getByRole('button', { name: 'End call' }).click();
    await expect(b.getByText('Call ended.')).toBeVisible();

    // Second call on the same connection reuses transceivers.
    await b.getByRole('button', { name: 'Start video call' }).click();
    await a.getByRole('dialog', { name: 'Incoming video call' }).getByRole('button', { name: 'Accept' }).click();
    await expectVideoPlaying(a, 'video:not([muted])');
    await expectVideoPlaying(b, 'video:not([muted])');
    await close();
  });

  test('send files both ways, during a call, verified by SHA-256', async ({ browser }) => {
    const { a, b, close } = await twoPeers(browser);
    await pairWithCode(a, b);

    await a.getByRole('button', { name: 'Start video call' }).click();
    await b.getByRole('dialog', { name: 'Incoming video call' }).getByRole('button', { name: 'Accept' }).click();
    await expectVideoPlaying(a, 'video:not([muted])');

    const video = randomBytes(6 * 1024 * 1024);
    const photo = randomBytes(300 * 1024);
    await a.locator('input[type=file]').setInputFiles({ name: 'holiday.mp4', mimeType: 'video/mp4', buffer: video });
    await b.locator('input[type=file]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });

    for (const page of [a, b]) {
      await expect(page.getByText(/verified with SHA-256/)).toHaveCount(2, { timeout: 60_000 });
    }

    // The received bytes are exactly the sent bytes.
    const download = b.waitForEvent('download');
    await b.locator('li', { hasText: 'holiday.mp4' }).getByRole('button', { name: 'Save' }).click();
    const saved = await (await download).createReadStream();
    const hash = createHash('sha256');
    for await (const chunk of saved) hash.update(chunk as Buffer);
    expect(hash.digest('hex')).toBe(createHash('sha256').update(video).digest('hex'));
    await close();
  });

  test('sends any file type: documents, archives, apps', async ({ browser }) => {
    const { a, b, close } = await twoPeers(browser);
    await pairWithCode(a, b);

    const files = [
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: randomBytes(400 * 1024) },
      { name: 'photos.zip', mimeType: 'application/zip', buffer: randomBytes(1024 * 1024) },
      { name: 'game.apk', mimeType: 'application/vnd.android.package-archive', buffer: randomBytes(200 * 1024) },
    ];
    await a.locator('input[type=file]').setInputFiles(files);
    await expect(b.getByText(/verified with SHA-256/)).toHaveCount(3, { timeout: 60_000 });

    const pdf = b.locator('li', { hasText: 'report.pdf' });
    await expect(pdf.getByText('PDF', { exact: true })).toBeVisible();
    await expect(b.locator('li', { hasText: 'game.apk' }).getByText(/can run programs/)).toBeVisible();
    await expect(pdf.getByText(/can run programs/)).toHaveCount(0);

    const download = b.waitForEvent('download');
    await b.locator('li', { hasText: 'photos.zip' }).getByRole('button', { name: 'Save' }).click();
    const hash = createHash('sha256');
    for await (const chunk of await (await download).createReadStream()) hash.update(chunk as Buffer);
    expect(hash.digest('hex')).toBe(createHash('sha256').update(files[1]!.buffer).digest('hex'));
    await close();
  });

  test('session stats show live totals, and performance reports reach the log only when allowed', async ({ browser }) => {
    const { a, b, close } = await twoPeers(browser);
    const reports = (page: Page) => {
      const sent: Array<{ t: string; [key: string]: unknown }> = [];
      page.on('requestfinished', async (request) => {
        if (!request.url().endsWith('/api/metrics')) return;
        expect((await request.response())?.status()).toBe(204);
        sent.push(JSON.parse(request.postData() ?? '{}'));
      });
      return sent;
    };
    const fromA = reports(a);
    const fromB = reports(b);
    // B turns reports off first; the choice is kept on that device.
    await b.goto('/');
    await b.getByRole('button', { name: 'Settings' }).click();
    await b.getByLabel('Share performance stats').uncheck();
    await b.keyboard.press('Escape');

    await pairWithCode(a, b);
    await a.locator('input[type=file]').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: randomBytes(1024 * 1024) });
    await expect(b.getByText(/verified with SHA-256/)).toHaveCount(1, { timeout: 60_000 });

    const stats = a.getByRole('region', { name: 'Session stats' });
    await expect(stats.getByText('1 file sent')).toBeVisible();
    await expect(stats.getByText('1.00 MB')).toBeVisible();
    await expect(b.getByRole('region', { name: 'Session stats' }).getByText('1 file received')).toBeVisible();

    await expect.poll(() => fromA.map((r) => r.t)).toEqual(expect.arrayContaining(['connect', 'transfer']));
    expect(fromA.find((r) => r.t === 'transfer')).toMatchObject({ direction: 'out', status: 'done', bytes: 1024 * 1024, verified: true });
    expect(JSON.stringify(fromA)).not.toContain('clip.mp4');
    await a.getByRole('button', { name: 'Leave' }).click();
    await expect.poll(() => fromA.find((r) => r.t === 'session')).toMatchObject({ end: 'left', up: { bytes: 1024 * 1024, files: 1 } });
    expect(fromB).toEqual([]);
    await close();
  });

  test('the other side sees when someone leaves', async ({ browser }) => {
    const { a, b, close } = await twoPeers(browser);
    await pairWithCode(a, b);
    await a.getByRole('button', { name: 'Leave' }).click();
    await expect(b.getByRole('heading', { name: 'They left' })).toBeVisible();
    await close();
  });
});
