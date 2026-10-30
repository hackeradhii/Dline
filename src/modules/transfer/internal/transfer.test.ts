import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FileSink } from '../../../contracts/ports';
import type { BlockHeader } from '../../../contracts/transfer';
import { TRANSFER } from '../../../shared/config';
import { asChannel, fakeChannelPair, fakeLanes, type FakeDataChannel } from '../../../shared/testing/fake-channels';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { DataControlChannel } from '../../connection';
import { BlockReader } from './framing';
import { TransferManager, type TransferDeps } from './manager';
import type { TransferItem } from './record';
import { MemorySink } from './sinks';

const KB = 1024;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function randomFile(size: number, name = 'clip.mp4', type = 'video/mp4'): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536)));
  return new File([bytes], name, { type });
}

const sha = async (blob: Blob) => createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');

interface Options {
  lanes?: number;
  tamper?: FakeDataChannel['tamper'];
  controlLatencyMs?: number;
  clock?: FakeClock;
}

/** Two managers joined by a ctrl channel and `lanes` parallel lanes. */
async function setup({ lanes = 3, tamper = null, controlLatencyMs = 0, clock }: Options = {}) {
  const [ctrlA, ctrlB] = fakeChannelPair('ctrl');
  ctrlA.latencyMs = ctrlB.latencyMs = controlLatencyMs;
  const control = { a: new DataControlChannel(), b: new DataControlChannel() };
  control.a.attach(asChannel(ctrlA));
  control.b.attach(asChannel(ctrlB));
  const paths = await fakeLanes(lanes, 64 * KB, tamper);
  await settle();
  const deps = (side: 'a' | 'b'): TransferDeps => ({
    control: control[side],
    lanes: paths[side],
    sinks: async (_id, _size, mime) => new MemorySink(mime),
    ...(clock ? { clock } : {}),
  });
  return { sender: new TransferManager(deps('a')), receiver: new TransferManager(deps('b')), paths };
}

/** Resolves with the first final state of the item called `name` (any direction if omitted). */
function final(manager: TransferManager, name?: string): Promise<TransferItem> {
  return new Promise((resolve) =>
    manager.events.on('changed', (item) => {
      if ((!name || item.name === name) && ['done', 'failed', 'cancelled'].includes(item.status)) resolve(item);
    }),
  );
}

describe('file transfer', () => {
  it('spreads a file over parallel lanes and delivers it byte for byte, every block SHA-256 checked', async () => {
    const { sender, receiver, paths } = await setup({ lanes: 4 });
    const file = randomFile(3 * 1024 * 1024 + 12345);
    const used = new Set<number>();
    paths.b.lanes.forEach((lane) => lane.channel.addEventListener('message', () => used.add(lane.id)));
    const [sent, received] = [final(sender), final(receiver)];
    sender.send([file]);

    const [out, inn] = await Promise.all([sent, received]);
    expect(out).toMatchObject({ status: 'done', verified: true, bytes: file.size });
    expect(inn).toMatchObject({ status: 'done', verified: true, name: 'clip.mp4', mime: 'video/mp4', size: file.size, bytes: file.size });
    expect(await sha(inn.file!)).toBe(await sha(file));
    // Every extra lane carried blocks; lane 0 (shared with calls and control) stayed free.
    expect([...used].sort()).toEqual([1, 2, 3]);
  });

  it('falls back to the main connection alone', async () => {
    const { sender, receiver } = await setup({ lanes: 1 });
    const file = randomFile(700_000);
    const received = final(receiver);
    sender.send([file]);
    const item = await received;
    expect(item).toMatchObject({ status: 'done', verified: true });
    expect(await sha(item.file!)).toBe(await sha(file));
  });

  it('flags a block damaged in transit', async () => {
    let flipped = false;
    const { sender, receiver } = await setup({
      tamper: (bytes) => {
        if (!flipped) bytes[0] = bytes[0]! ^ 0xff; // Corrupt one byte of the first binary message.
        flipped = true;
      },
    });
    const [sent, received] = [final(sender), final(receiver)];
    sender.send([randomFile(200_000)]);

    expect(await received).toMatchObject({ status: 'failed', verified: false });
    expect(await sent).toMatchObject({ status: 'failed', verified: false });
  });

  it('handles empty files', async () => {
    const { sender, receiver } = await setup();
    const [sent, received] = [final(sender), final(receiver)];
    sender.send([randomFile(0, 'empty.jpg', 'image/jpeg')]);
    expect(await received).toMatchObject({ status: 'done', verified: true, size: 0 });
    expect(await sent).toMatchObject({ status: 'done', verified: true });
  });

  it('sends a batch back to back, every file intact', async () => {
    const { sender, receiver } = await setup();
    const files = [randomFile(10_000, 'a.jpg'), randomFile(300_000, 'b.jpg'), randomFile(30_000, 'c.jpg')];
    const arrived = Promise.all(files.map((f) => final(receiver, f.name)));
    sender.send(files);
    const items = await arrived;
    expect(items.map((i) => i.status)).toEqual(['done', 'done', 'done']);
    for (const [i, item] of items.entries()) expect(await sha(item.file!)).toBe(await sha(files[i]!));
  });

  it('cancels a queued file before it starts', async () => {
    const { sender } = await setup();
    const items: TransferItem[] = [];
    sender.events.on('changed', (i) => items.push(i));
    sender.send([randomFile(2_000_000, 'big.mp4'), randomFile(10, 'later.jpg')]);
    const later = items.find((i) => i.name === 'later.jpg')!;
    sender.cancel(later.id);
    expect(items.at(-1)).toMatchObject({ name: 'later.jpg', status: 'cancelled' });
  });

  it('keeps going when a lane closes mid-file: its blocks are re-sent on the others', async () => {
    const { sender, receiver, paths } = await setup({ lanes: 4 });
    const file = randomFile(2 * 1024 * 1024);
    const doomed = paths.b.lanes[1]!.channel;
    doomed.addEventListener('message', () => doomed.close(), { once: true });
    const received = final(receiver);
    sender.send([file]);

    const item = await received;
    expect(item).toMatchObject({ status: 'done', verified: true });
    expect(await sha(item.file!)).toBe(await sha(file));
  });

  it('does not wait on a stalled lane at the end of a file: idle lanes carry copies of its blocks', async () => {
    const { sender, receiver, paths } = await setup({ lanes: 4 });
    paths.channels[1]![0].latencyMs = 60_000; // Stuck in loss recovery for longer than the test runs.
    const file = randomFile(1024 * 1024);
    const received = final(receiver);
    sender.send([file]);

    const item = await received;
    expect(item).toMatchObject({ status: 'done', verified: true });
    expect(await sha(item.file!)).toBe(await sha(file));
  });

  it('sends a block again when the receiver never got it (e.g. it had no room to hold it)', async () => {
    const { sender, receiver, paths } = await setup({ lanes: 4 });
    // Swallow the first whole block (header and its chunks) that reaches the receiver on lane 2.
    const lane = paths.channels[2]![1];
    const deliver = lane.deliver.bind(lane);
    let swallow = 0;
    let swallowed = false;
    lane.deliver = (data) => {
      if (!swallowed && typeof data === 'string') [swallowed, swallow] = [true, 1 + Math.ceil(TRANSFER.blockBytes / (64 * KB))];
      if (swallow > 0) return void swallow--;
      deliver(data);
    };
    const files = [randomFile(600_000, 'a.jpg'), randomFile(600_000, 'b.jpg'), randomFile(600_000, 'c.jpg')];
    const done = files.map((f) => final(receiver, f.name));
    sender.send(files);

    const items = await Promise.all(done);
    expect(swallowed).toBe(true);
    expect(items.map((i) => i.status)).toEqual(['done', 'done', 'done']);
    for (const [k, item] of items.entries()) expect(await sha(item.file!)).toBe(await sha(files[k]!));
  });

  it('holds blocks that arrive before their file is announced', async () => {
    const { sender, receiver } = await setup({ controlLatencyMs: 30 });
    const file = randomFile(500_000);
    const received = final(receiver);
    sender.send([file]);
    const item = await received;
    expect(item).toMatchObject({ status: 'done', verified: true });
    expect(await sha(item.file!)).toBe(await sha(file));
  });

  it('lets the receiver cancel', async () => {
    const { sender, receiver } = await setup();
    receiver.events.on('changed', (item) => item.status === 'transferring' && receiver.cancel(item.id));
    const sent = final(sender);
    sender.send([randomFile(3_000_000)]);
    expect(await sent).toMatchObject({ status: 'cancelled' });
  });

  it('gives up when the other side stops answering', async () => {
    const clock = new FakeClock();
    const { sender, paths } = await setup({ clock });
    paths.b.lanes.forEach((lane) => lane.channel.close()); // Nothing gets through any more.
    await settle();
    const sent = final(sender);
    sender.send([randomFile(100_000)]);
    await settle();
    clock.advance(TRANSFER.stallTimeoutMs + TRANSFER.stallCheckMs);
    expect(await sent).toMatchObject({ status: 'failed', error: 'No response from the other device.' });
  });
});

describe('block framing', () => {
  const header: BlockHeader = { t: 'blk', f: 'abcdefgh', i: 0, n: 4, h: '0'.repeat(64) };

  it('reassembles a block from several messages', () => {
    const blocks: number[][] = [];
    const reader = new BlockReader((_, data) => blocks.push([...new Uint8Array(data)]));
    expect(reader.push(JSON.stringify(header))).toBe(true);
    expect(reader.push(new Uint8Array([1, 2]).buffer)).toBe(true);
    expect(reader.push(new Uint8Array([3, 4]).buffer)).toBe(true);
    expect(blocks).toEqual([[1, 2, 3, 4]]);
  });

  it.each([
    ['data without a header', [new Uint8Array([1]).buffer]],
    ['a header inside a block', [JSON.stringify(header), new Uint8Array([1]).buffer, JSON.stringify(header)]],
    ['more bytes than announced', [JSON.stringify(header), new Uint8Array(5).buffer]],
    ['a malformed header', ['{"t":"blk"}']],
  ])('rejects %s', (_, messages) => {
    const reader = new BlockReader(() => undefined);
    expect(messages.map((m) => reader.push(m))).toContain(false);
  });
});

/** Contract every FileSink must satisfy (Liskov): run it against each implementation. */
function fileSinkContract(name: string, make: () => Promise<FileSink>) {
  describe(`FileSink contract: ${name}`, () => {
    it('returns exactly the bytes written, whatever the order', async () => {
      const sink = await make();
      await sink.write(3, new Uint8Array([4, 5]).buffer);
      await sink.write(0, new Uint8Array([1, 2, 3]).buffer);
      expect([...new Uint8Array(await (await sink.close()).arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
    });

    it('can be aborted without throwing', async () => {
      const sink = await make();
      await sink.write(0, new Uint8Array([1]).buffer);
      await expect(sink.abort()).resolves.toBeUndefined();
    });
  });
}

fileSinkContract('MemorySink', async () => new MemorySink('image/png'));
