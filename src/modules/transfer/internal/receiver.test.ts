import { describe, expect, it } from 'vitest';
import type { FileSink } from '../../../contracts/ports';
import type { BlockHeader, FileOffer, TransferControl } from '../../../contracts/transfer';
import { flush } from '../../../shared/testing/drive';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { Receiver } from './receiver';
import { TransferRecord, type TransferItem } from './record';

const HASH = 'a'.repeat(64);
const BLOCK = 16 * 1024;
const offer = (f: string, blocks = 1): FileOffer => ({ t: 'file', f, name: `${f}.bin`, size: blocks * BLOCK, mime: 'application/octet-stream', block: BLOCK });
const block = (f: string, i = 0): [BlockHeader, ArrayBuffer] => [{ t: 'blk', f, i, n: BLOCK, h: HASH }, new ArrayBuffer(BLOCK)];

function setup() {
  const clock = new FakeClock();
  const replies: TransferControl[] = [];
  const items = new Map<string, TransferItem>();
  const sinks: string[] = [];
  const sink: FileSink = { write: async () => undefined, close: async () => new Blob(), abort: async () => undefined };
  const receiver = new Receiver({
    sinks: async (id) => (sinks.push(id), sink),
    hasher: { digest: async () => HASH },
    clock,
    reply: (m) => replies.push(m),
    record: (init) => new TransferRecord(init, (item) => items.set(item.id, item), clock),
  });
  return { receiver, replies, items, sinks, clock };
}

const FILE = 'file-0001';

describe('Receiver', () => {
  it('stores and acknowledges blocks of an announced file, and reports it done', async () => {
    const { receiver, replies, items } = setup();
    receiver.offer(offer(FILE));
    receiver.block(...block(FILE));
    await flush();
    await flush();
    expect(replies).toContainEqual({ t: 'file-ack', f: FILE, i: 0 });
    expect(items.get(FILE)).toMatchObject({ status: 'done', verified: true });
  });

  it('holds blocks that beat their offer, and times the file from the first byte', async () => {
    const { receiver, replies, items, clock } = setup();
    clock.advance(100);
    receiver.block(...block(FILE));
    clock.advance(50);
    receiver.offer(offer(FILE));
    await flush();
    await flush();
    expect(replies).toContainEqual({ t: 'file-ack', f: FILE, i: 0 });
    expect(items.get(FILE)?.startedAt).toBe(100);
  });

  it('ignores a repeated offer, and drops late copies of blocks once the file ended', async () => {
    const { receiver, replies, sinks } = setup();
    receiver.offer(offer(FILE));
    receiver.offer(offer(FILE));
    receiver.block(...block(FILE));
    await flush();
    await flush();
    const acks = replies.length;
    receiver.block(...block(FILE)); // A re-sent copy after the end: not held, not acked.
    receiver.offer(offer(FILE));
    await flush();
    expect(sinks).toEqual([FILE]);
    expect(replies).toHaveLength(acks);
  });

  it('a file the sender cancelled before its offer arrived never starts', async () => {
    const { receiver, items } = setup();
    receiver.block(...block(FILE));
    receiver.cancelledByPeer(FILE);
    receiver.offer(offer(FILE));
    await flush();
    expect(items.has(FILE)).toBe(false);
  });

  it('we can cancel an incoming file, and the sender is told', async () => {
    const { receiver, replies, items } = setup();
    receiver.offer(offer(FILE, 2));
    receiver.cancel(FILE);
    await flush();
    expect(items.get(FILE)?.status).toBe('cancelled');
    expect(replies).toContainEqual({ t: 'file-cancel', f: FILE });
  });
});
