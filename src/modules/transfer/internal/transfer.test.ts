import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ControlMessage, ControlOf, ControlType } from '../../../contracts/control';
import type { BlockHasher, ControlChannel, FileSink } from '../../../contracts/ports';
import type { BlockHeader } from '../../../contracts/transfer';
import { randomId } from '../../../shared/bytes';
import { FLOW, TRANSFER } from '../../../shared/config';
import type { Unsubscribe } from '../../../shared/emitter';
import { run, until, worstBurst } from '../../../shared/testing/drive';
import { SimControl } from '../../../shared/testing/fake-bottleneck';
import { asChannel, fakeChannelPair, fakeLanes, type FakeDataChannel } from '../../../shared/testing/fake-channels';
import { FakeClock, FakeVisibility, ThrottledClock } from '../../../shared/testing/fake-clock';
import { DataControlChannel } from '../../connection';
import { Pacer } from './flow';
import { FlowProbe } from './flow-probe';
import { FlowResponder } from './flow-responder';
import { BlockReader, writeBlock, writeMark } from './framing';
import { TransferManager, type TransferDeps } from './manager';
import { OutgoingFile } from './outgoing';
import type { Actuator, PacingMode } from './pacing-selector';
import type { RatePolicy } from './rate-policy';
import { TransferRecord, type TransferItem } from './record';
import { BlockScheduler } from './scheduler';
import { MemorySink } from './sinks';

const KB = 1024;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function randomFile(size: number, name = 'clip.mp4', type = 'video/mp4'): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536)));
  return new File([bytes], name, { type });
}

const sha = async (blob: Blob) => createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');

type Side = 'a' | 'b';

interface Options {
  lanes?: number;
  tamper?: FakeDataChannel['tamper'];
  controlLatencyMs?: number;
  clock?: FakeClock;
  /** Each side's file pacing (default: legacy). */
  pacing?: Partial<Record<Side, PacingMode>>;
  /** How a side's ctrl differs from this version's, e.g. an app from before Flow. */
  control?: Partial<Record<Side, (control: ControlChannel) => ControlChannel>>;
  /** The sender's legacy budget. */
  legacy?: RatePolicy;
  hasher?: BlockHasher;
}

/** Two managers joined by a ctrl channel and `lanes` parallel lanes. */
async function setup({ lanes = 3, tamper = null, controlLatencyMs = 0, clock, pacing = {}, control: differs = {}, legacy, hasher }: Options = {}) {
  const [ctrlA, ctrlB] = fakeChannelPair('ctrl');
  ctrlA.latencyMs = ctrlB.latencyMs = controlLatencyMs;
  const control = { a: new DataControlChannel(), b: new DataControlChannel() };
  control.a.attach(asChannel(ctrlA));
  control.b.attach(asChannel(ctrlB));
  const paths = await fakeLanes(lanes, 64 * KB, tamper);
  await settle();
  const deps = (side: Side): TransferDeps => ({
    control: differs[side]?.(control[side]) ?? control[side],
    lanes: paths[side],
    sinks: async (_id, _size, mime) => new MemorySink(mime),
    pacing: pacing[side] ?? 'legacy',
    ...(clock ? { clock } : {}),
    ...(hasher ? { hasher } : {}),
    ...(side === 'a' && legacy ? { legacy } : {}),
  });
  return { sender: new TransferManager(deps('a')), receiver: new TransferManager(deps('b')), paths };
}

/** SHA-256 computed in place, so blocks are ready without waiting on the event loop (fake-clock tests). */
const nodeHasher: BlockHasher = { digest: async (data) => createHash('sha256').update(new Uint8Array(data)).digest('hex') };

/** ctrl as another version of the app uses it; this one passes everything through. */
class OtherVersion implements ControlChannel {
  constructor(protected readonly inner: ControlChannel) {}

  get isOpen(): boolean {
    return this.inner.isOpen;
  }

  send(message: ControlMessage): boolean {
    return this.inner.send(message);
  }

  on<T extends ControlType>(type: T, handler: (message: ControlOf<T>) => void): Unsubscribe {
    return this.inner.on(type, handler);
  }
}

const isFlow = (type: ControlType) => type.startsWith('flow-');

/** Today's app, from before Flow: its schema has no flow messages, so it ignores them and sends none. */
class BeforeFlow extends OtherVersion {
  override send(message: ControlMessage): boolean {
    return isFlow(message.t) || super.send(message);
  }

  override on<T extends ControlType>(type: T, handler: (message: ControlOf<T>) => void): Unsubscribe {
    return isFlow(type) ? () => undefined : super.on(type, handler);
  }
}

/** A peer that answers probes, but its echoes arrive `ms` late. */
class LateEchoes extends OtherVersion {
  constructor(
    inner: ControlChannel,
    private readonly clock: FakeClock,
    private readonly ms: number,
  ) {
    super(inner);
  }

  override send(message: ControlMessage): boolean {
    if (message.t !== 'flow-echo') return super.send(message);
    this.clock.setTimeout(() => super.send(message), this.ms);
    return true;
  }
}

/** When each block header left the sender, whether Flow was in charge right then, and the budget in force. */
function headersSent(paths: Awaited<ReturnType<typeof fakeLanes>>, sender: TransferManager, clock: FakeClock) {
  const sent: Array<{ t: number; flow: boolean; limit: number | null }> = [];
  for (const [mine] of paths.channels) {
    const send = mine.send.bind(mine);
    mine.send = (data) => {
      if (typeof data === 'string' && data.includes('"t":"blk"')) sent.push({ t: clock.now(), flow: sender.pacing.flowInCharge, limit: sender.pacing.limit });
      send(data);
    };
  }
  return sent;
}

/** The final state of each item `manager` reports, by id. */
function finals(manager: TransferManager): Map<string, TransferItem> {
  const items = new Map<string, TransferItem>();
  manager.events.on('changed', (item) => {
    if (['done', 'failed', 'cancelled'].includes(item.status)) items.set(item.id, item);
  });
  return items;
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
    expect(await sent).toMatchObject({ status: 'failed', error: 'no-response' });
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

  it('reports drain markers found between blocks, in order with the blocks', () => {
    const seen: string[] = [];
    const reader = new BlockReader(
      (h) => seen.push(`block ${h.i}`),
      (m) => seen.push(`mark ${m}`),
    );
    const mark = (m: number) => JSON.stringify({ t: 'mark', m });
    const messages = [mark(1), JSON.stringify(header), new Uint8Array(4).buffer, mark(2)];
    expect(messages.map((m) => reader.push(m))).toEqual([true, true, true, true]);
    expect(seen).toEqual(['mark 1', 'block 0', 'mark 2']);
  });

  it('writes a paced block in the pacer’s chunk sizes, and a marker after it, read back as sent', async () => {
    const sent: Array<string | ArrayBuffer> = [];
    const channel = { send: (m: string | Uint8Array) => sent.push(typeof m === 'string' ? m : m.slice().buffer) };
    const lane = { id: 3, channel: channel as unknown as RTCDataChannel, chunkBytes: 64 * KB };
    const waits: number[] = [];
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await writeBlock(lane, { ...header, n: data.byteLength }, data, { chunkBytes: () => 3, beforeChunk: async (bytes) => void waits.push(bytes) });
    writeMark(lane, 7);
    expect(waits).toEqual([3, 3, 3, 1]);

    const seen: unknown[] = [];
    const reader = new BlockReader(
      (_, block) => seen.push([...new Uint8Array(block)]),
      (m) => seen.push(m),
    );
    expect(sent.map((m) => reader.push(m))).not.toContain(false);
    expect(seen).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 7]);
  });

  it.each([
    ['data without a header', [new Uint8Array([1]).buffer]],
    ['a header inside a block', [JSON.stringify(header), new Uint8Array([1]).buffer, JSON.stringify(header)]],
    ['a marker inside a block', [JSON.stringify(header), new Uint8Array([1]).buffer, JSON.stringify({ t: 'mark', m: 1 })]],
    ['more bytes than announced', [JSON.stringify(header), new Uint8Array(5).buffer]],
    ['a malformed header', ['{"t":"blk"}']],
    ['a malformed marker', ['{"t":"mark"}']],
  ])('rejects %s', (_, messages) => {
    const reader = new BlockReader(() => undefined);
    expect(messages.map((m) => reader.push(m))).toContain(false);
  });
});

describe('Flow and other versions (FLOW-03)', () => {
  const MIB = 1024 * KB;
  /** The sender's legacy budget: slow enough to show when it applies (2 MiB take 8 s). */
  const LEGACY = TRANSFER.minFileBytesPerSecond;

  /**
   * A sender in flow mode sends 2 MiB to a receiver whose ctrl is `receiver`'s. A stats tick has
   * measured the path, near like these fakes (ICE's round trip), unless `iceRttMs` is null.
   */
  async function flowSender(receiver: (control: ControlChannel, clock: FakeClock) => ControlChannel, { iceRttMs = 1 as number | null, call = false } = {}) {
    const clock = new FakeClock();
    const t = await setup({ clock, pacing: { a: 'flow', b: 'flow' }, control: { b: (c) => receiver(c, clock) }, legacy: { limit: LEGACY }, hasher: nodeHasher });
    t.sender.setFlowInputs({ pathKey: 'pair-1', pathRttMs: iceRttMs, callActive: call, videoOn: call });
    const headers = headersSent(t.paths, t.sender, clock);
    const done = finals(t.receiver);
    t.sender.send([randomFile(2 * MIB)]);
    const ms = await until(clock, () => done.size === 1);
    return { headers, ms, item: [...done.values()][0]! };
  }

  it('an echo within a round trip: Flow applies from the first byte', async () => {
    const t = await flowSender((c) => c);
    expect(t.headers[0]!.flow).toBe(true);
    expect(t.item).toMatchObject({ status: 'done', verified: true });
    expect(t.ms).toBeLessThan(1_000); // Not held to the legacy budget.
  });

  it('an echo after 500 ms: the first block waits for it, and Flow applies from the first byte', async () => {
    const t = await flowSender((c, clock) => new LateEchoes(c, clock, 500));
    expect(t.headers[0]).toEqual({ t: 500, flow: true, limit: null });
    expect(t.item).toMatchObject({ status: 'done', verified: true });
  });

  it('an echo after 3 s: legacy for the first blocks, then Flow from a block boundary', async () => {
    const t = await flowSender((c, clock) => new LateEchoes(c, clock, 3_000));
    const early = t.headers.filter((h) => h.t < 3_000);
    expect(early.length).toBeGreaterThan(1);
    expect(early.every((h) => !h.flow)).toBe(true);
    expect(t.headers.at(-1)!.flow).toBe(true);
    expect(t.ms).toBeLessThan(4_000);
    expect(t.item).toMatchObject({ status: 'done', verified: true }); // No block was cut by the switch.
  });

  it('files picked before anything measured the path, during a call: the first echo shows it far, and the first block starts gently', async () => {
    const t = await flowSender((c, clock) => new LateEchoes(c, clock, 500), { iceRttMs: null, call: true });
    expect(t.headers[0]).toEqual({ t: 500, flow: true, limit: FLOW.callStartBytesPerSecond });
    expect(t.item).toMatchObject({ status: 'done', verified: true });
  });

  it('a block waiting for legacy’s tokens as Flow takes over and drains at once waits out the hold, behind the markers', async () => {
    const clock = new FakeClock();
    const pacing = { actuator: 'block' as Actuator, limit: LEGACY as number | null, ready: async () => undefined };
    const pacer = new Pacer(() => pacing.limit, clock);
    const scheduler = new BlockScheduler({ hasher: nodeHasher, pacer, pacing, clock, onStart: (file) => file.start(), onError: () => undefined, onWrite: () => undefined });
    const paths = await fakeLanes(1, 64 * KB);
    const sent: string[] = [];
    const [mine] = paths.channels[0]!;
    const send = mine.send.bind(mine);
    mine.send = (data) => {
      if (typeof data === 'string') sent.push(`${(JSON.parse(data) as { t: string }).t} at ${clock.now()}`);
      send(data);
    };
    scheduler.addLane(paths.a.lanes[0]!);
    const record = new TransferRecord({ id: 'f', direction: 'out', name: 'f', size: 2 * TRANSFER.blockBytes, mime: '' }, () => undefined, clock);
    scheduler.add(new OutgoingFile('f', randomFile(2 * TRANSFER.blockBytes), record, TRANSFER.blockBytes, clock));
    await run(clock, 200); // The first block waits for its tokens: 128 KiB at 256 KiB/s.
    Object.assign(pacing, { actuator: 'fine', limit: 0 }); // Flow takes over, and its drain holds new blocks.
    scheduler.mark(1);
    pacer.poke();
    await run(clock, 1_000);
    expect(sent).toEqual(['mark at 200']);
    pacing.limit = MIB; // The hold ends.
    pacer.poke();
    await run(clock, 10);
    expect(sent.slice(0, 2)).toEqual(['mark at 200', 'blk at 1200']);
  });

  it('no echo, from an app before Flow: legacy after a 1 s wait, and the file completes', async () => {
    const t = await flowSender((c) => new BeforeFlow(c));
    expect(t.headers[0]!.t).toBeGreaterThanOrEqual(FLOW.capabilityHoldMs);
    expect(t.headers.every((h) => !h.flow)).toBe(true);
    expect(t.ms).toBeGreaterThan(((2 * MIB) / LEGACY) * 1000);
    expect(t.item).toMatchObject({ status: 'done', verified: true });
  });

  it('an app from before Flow sending to this one: the file completes', async () => {
    const clock = new FakeClock();
    const t = await setup({ clock, pacing: { b: 'flow' }, control: { a: (c) => new BeforeFlow(c) }, hasher: nodeHasher });
    const done = finals(t.receiver);
    t.sender.send([randomFile(2 * MIB)]);
    await until(clock, () => done.size === 1);
    expect([...done.values()][0]).toMatchObject({ status: 'done', verified: true });
    expect(t.receiver.pacing.flowInCharge).toBe(false);
  });
});

describe('pacing in every mode (FLOW-02, FLOW-07, FLOW-09)', () => {
  it.each(['legacy', 'shadow'] as const)('%s sends exactly as today: whole blocks at the budget, in lane-sized messages', async (mode) => {
    const clock = new FakeClock();
    const t = await setup({ clock, lanes: 2, pacing: { a: mode, b: mode }, legacy: { limit: 1024 * KB }, hasher: nodeHasher });
    const headers = headersSent(t.paths, t.sender, clock);
    const sizes = new Set<number>();
    for (const lane of t.paths.b.lanes) lane.channel.addEventListener('message', ({ data }) => data instanceof ArrayBuffer && sizes.add(data.byteLength));
    const done = finals(t.receiver);
    t.sender.send([randomFile(1024 * KB)]);
    await until(clock, () => done.size === 1);
    // 128 KiB at 1 MiB/s is 125 ms each, from an empty bucket.
    expect(headers.map((h) => h.t)).toEqual([125, 250, 375, 500, 625, 750, 875, 1_000]);
    expect([...sizes]).toEqual([64 * KB]);
  });

  it('a batch paced at the floor for over 30 s completes: only blocks in flight run the stall clock (FLOW-02)', async () => {
    const clock = new FakeClock();
    const t = await setup({ clock, legacy: { limit: FLOW.minBytesPerSecond }, hasher: nodeHasher });
    const done = finals(t.sender);
    t.sender.send(Array.from({ length: 20 }, (_, i) => randomFile(128 * KB, `${i}.jpg`)));
    const ms = await until(clock, () => done.size === 20, { stepMs: 10 });
    expect(ms).toBeGreaterThan(2 * TRANSFER.stallTimeoutMs);
    expect([...done.values()].map((item) => item.status)).toEqual(Array(20).fill('done'));
  });

  it('fails pending files once the only lane has been gone for the stall timeout, while ctrl is fine (FLOW-09)', async () => {
    const clock = new FakeClock();
    const t = await setup({ clock, lanes: 1, legacy: { limit: TRANSFER.minFileBytesPerSecond }, hasher: nodeHasher });
    const done = finals(t.sender);
    t.sender.send([randomFile(2 * 1024 * KB)]);
    await run(clock, 1_000);
    t.paths.channels[0]![0].close(); // Lane 0, the only one.
    await until(clock, () => done.size === 1, { stepMs: 100, limitMs: TRANSFER.stallTimeoutMs + 2 * TRANSFER.stallCheckMs });
    expect([...done.values()][0]).toMatchObject({ status: 'failed', error: 'no-response' });
  });
});

/**
 * The sender's scheduler, pacer and framing on one lane under a fixed Flow budget (the fine
 * actuator), and a receiver that reads the lane and acks each block a round trip later. Flow's
 * probe and responder run beside them, and every echo pokes the pacer, as in the app. The
 * controller isn't here: these tests are about how a budget is applied (PLAN.md §5.5).
 */
async function pacedSender({ rate, visibility = new FakeVisibility(), rttMs = 50 }: { rate: number; visibility?: FakeVisibility; rttMs?: number }) {
  const clock = new ThrottledClock(visibility);
  const pacer = new Pacer(() => rate, clock, visibility);
  const oneWay = (arrive: () => void) => clock.network(arrive, rttMs / 2);
  const control = SimControl.linked(oneWay, oneWay);
  new FlowResponder(control.b, clock);
  const probe = new FlowProbe(control.a, clock, () => clock.now(), visibility);
  probe.events.on('sample', () => pacer.poke());
  const files = new Map<string, OutgoingFile>();
  const scheduler = new BlockScheduler({
    hasher: nodeHasher,
    pacer,
    pacing: { actuator: 'fine', ready: async () => undefined },
    clock,
    onStart: (file) => file.start(),
    onError: () => undefined,
    onWrite: () => undefined,
  });
  const paths = await fakeLanes(1, 64 * KB);
  const chunks: Array<{ t: number; bytes: number }> = [];
  const blocks: Array<{ f: string; i: number }> = [];
  let corrupt = false;
  const reader = new BlockReader((header) => {
    blocks.push({ f: header.f, i: header.i });
    oneWay(() => {
      const file = files.get(header.f);
      if (file) scheduler.acked(file.ack(header.i));
      probe.acked();
    });
  });
  paths.b.lanes[0]!.channel.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) chunks.push({ t: clock.now(), bytes: data.byteLength });
    if (!reader.push(data)) corrupt = true;
  });
  scheduler.addLane(paths.a.lanes[0]!);
  probe.sending(true);
  return {
    clock,
    chunks,
    blocks,
    get corrupt() {
      return corrupt;
    },
    /** Bytes that reached the receiver so far. */
    get delivered() {
      return chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
    },
    send(size: number): OutgoingFile {
      const id = randomId();
      const record = new TransferRecord({ id, direction: 'out', name: id, size, mime: '' }, () => undefined, clock);
      const file = new OutgoingFile(id, randomFile(size), record, TRANSFER.blockBytes, clock);
      files.set(id, file);
      scheduler.add(file);
      return file;
    },
    /** As the manager cancels a file. */
    cancel(file: OutgoingFile): void {
      file.record.update({ status: 'cancelled' });
      scheduler.remove(file);
    },
  };
}

describe('fine pacing on the lanes (FLOW-01, PLAN.md §5.5)', () => {
  it.each([FLOW.minBytesPerSecond, 256 * KB])('at %d B/s blocks leave as an even trickle, and files keep moving', async (rate) => {
    const t = await pacedSender({ rate });
    const file = t.send(Math.max(128 * KB, 2 * rate));
    const ms = await until(t.clock, () => file.complete);
    const cap = Math.max((rate * FLOW.burstMs) / 1000, FLOW.minPacedChunkBytes);
    expect(worstBurst(t.chunks, rate)).toBeLessThanOrEqual(cap + 1);
    expect((file.file.size * 1000) / ms / rate).toBeGreaterThan(0.9);
    expect(t.corrupt).toBe(false);
  });

  it('a file cancelled mid-block still finishes that block on its lane, so the lane stays readable', async () => {
    const t = await pacedSender({ rate: 256 * KB });
    const first = t.send(512 * KB);
    const second = t.send(256 * KB);
    await until(t.clock, () => t.chunks.length >= 10); // Part-way through the first block.
    t.cancel(first);
    await until(t.clock, () => second.complete);
    expect(t.corrupt).toBe(false);
    expect(t.blocks).toEqual([
      { f: first.id, i: 0 },
      { f: second.id, i: 0 },
      { f: second.id, i: 1 },
    ]);
  });

  it.each([20, 50, 200])('in a hidden tab, with timers firing once a second, keeps at least half its budget (RTT %d ms)', async (rttMs) => {
    const rate = 256 * KB;
    const visibility = new FakeVisibility();
    const t = await pacedSender({ rate, visibility, rttMs });
    t.send(8 * 1024 * KB);
    await run(t.clock, 2_000);
    visibility.set(false);
    const before = t.delivered;
    await run(t.clock, 20_000);
    expect((t.delivered - before) / ((rate * 20_000) / 1000)).toBeGreaterThanOrEqual(0.5);
    expect(t.corrupt).toBe(false);
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
