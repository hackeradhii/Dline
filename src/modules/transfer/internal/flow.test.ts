import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { flush, timed, worstBurst } from '../../../shared/testing/drive';
import { FakeClock, FakeVisibility, ThrottledClock } from '../../../shared/testing/fake-clock';
import { Pacer, SpeedMeter } from './flow';

const KIB = 1024;
const MIB = 1024 * KIB;

/** Sends one block of `bytes` the way the fine actuator does; returns when each chunk went. */
async function fineBlock(pacer: Pacer, clock: FakeClock, bytes: number, laneChunkBytes = 64 * KIB): Promise<Array<{ t: number; bytes: number }>> {
  const sends: Array<{ t: number; bytes: number }> = [];
  await pacer.startBlock();
  for (let left = bytes; left > 0; ) {
    const chunk = Math.min(left, pacer.chunkBytes(laneChunkBytes));
    await pacer.takeChunk(chunk);
    sends.push({ t: clock.now(), bytes: chunk });
    left -= chunk;
  }
  return sends;
}

const within = (actual: number, expected: number, share: number) => expect(Math.abs(actual / expected - 1)).toBeLessThan(share);

describe('SpeedMeter', () => {
  const rate = 1_000_000;

  it('reads a constant rate sampled every 40 ms within 1 % (FLOW-05)', () => {
    const meter = new SpeedMeter(new FakeClock());
    for (let t = 0; t <= 5_000; t += 40) meter.record((rate * t) / 1000, t);
    within(meter.bytesPerSecond, rate, 0.01);
  });

  it('reads irregular samples within 1 %', () => {
    const meter = new SpeedMeter(new FakeClock());
    const gaps = [3, 57, 140, 12, 99, 1, 101, 45, 77, 130, 8, 64];
    for (let i = 0, t = 0; t < 6_000; t += gaps[i++ % gaps.length]!) meter.record((rate * t) / 1000, t);
    within(meter.bytesPerSecond, rate, 0.01);
  });

  it('follows a change once the old rate has left its window, and estimates the time left', () => {
    const meter = new SpeedMeter(new FakeClock(), 3_000);
    const bytesAt = (t: number) => (t <= 4_000 ? 2 * t : 8_000 + (t - 4_000)) * 1000;
    for (let t = 0; t <= 7_500; t += 40) meter.record(bytesAt(t), t);
    within(meter.bytesPerSecond, rate, 0.01);
    within(meter.etaMs(500_000), 500, 0.01);
    expect(new SpeedMeter(new FakeClock()).etaMs(1)).toBe(Infinity);
  });
});

describe('Pacer: block actuator (today’s pacing, FLOW-07)', () => {
  it('lets whole blocks go at the budget and records that the budget set the pace', async () => {
    const clock = new FakeClock();
    const pacer = new Pacer(() => MIB, clock);
    const blocks = (async () => {
      for (let i = 0; i < 8; i++) await pacer.takeBlock(128 * KIB);
    })();
    expect(await timed(clock, blocks)).toBe(1_000);
    expect(pacer.lastWaitAt).toBe(875);
  });

  it('after a pause lets out at most 100 ms of the budget at once', async () => {
    const clock = new FakeClock();
    const pacer = new Pacer(() => MIB, clock);
    clock.advance(5_000);
    expect(await timed(clock, pacer.takeBlock(64 * KIB))).toBe(0);
    // 100 ms of 1 MiB/s is 102.4 KiB: 38.4 KiB were left, so the next 128 KiB waits for 89.6 KiB.
    expect(await timed(clock, pacer.takeBlock(128 * KIB))).toBeCloseTo(87.5, -1);
  });

  it('never waits without a budget, and holds every new block while the budget is 0', async () => {
    const clock = new FakeClock();
    let limit: number | null = null;
    const pacer = new Pacer(() => limit, clock);
    expect(await timed(clock, pacer.takeBlock(4 * MIB))).toBe(0);

    limit = 0;
    let started = false;
    const held = pacer.takeBlock(KIB).then(() => {
      started = true;
    });
    clock.advance(10_000);
    await flush();
    expect(started).toBe(false);
    limit = MIB;
    pacer.poke();
    await timed(clock, held);
    expect(started).toBe(true);
  });
});

describe('Pacer: fine actuator (FLOW-01)', () => {
  it.each([
    ['the 32 KiB/s floor: 1 KiB, not 164 B', FLOW.minBytesPerSecond, 64 * KIB, KIB],
    ['256 KiB/s: 5 ms of it', 256 * KIB, 64 * KIB, 1311],
    ['10 MiB/s: at most 16 KiB', 10 * MIB, 64 * KIB, 16 * KIB],
    ['a lane that allows less', 10 * MIB, 4 * KIB, 4 * KIB],
    ['no budget: what the lane allows', null, 64 * KIB, 64 * KIB],
  ])('sizes chunks to the budget at %s', (_, limit, laneChunkBytes, expected) => {
    expect(new Pacer(() => limit, new FakeClock()).chunkBytes(laneChunkBytes)).toBe(expected);
  });

  it.each([FLOW.minBytesPerSecond, 256 * KIB])('at %d B/s sends a block as an even trickle: never more than max(10 ms of it, 1 KiB) at once', async (rate) => {
    const clock = new FakeClock();
    const pacer = new Pacer(() => rate, clock);
    clock.advance(5_000); // Idle first, so the bucket is full.
    let sends: Array<{ t: number; bytes: number }> = [];
    const elapsed = await timed(clock, fineBlock(pacer, clock, 128 * KIB).then((s) => (sends = s)));
    const cap = Math.max((rate * FLOW.burstMs) / 1000, FLOW.minPacedChunkBytes);
    expect(worstBurst(sends, rate)).toBeLessThanOrEqual(cap + 1);
    // And it keeps making progress at the rate, though timers here fire up to 1 ms late.
    expect(((128 * KIB - cap) * 1000) / rate / elapsed).toBeGreaterThan(0.95);
  });

  it('keeps to the budget when every timer fires 3 ms late: the bucket keeps what they owe, and bursts stay within it', async () => {
    // In the browser, timers wake a little late; with chunks as big as the bucket, that lost 17 % of the budget on the bench.
    class LateClock extends FakeClock {
      override setTimeout(fn: () => void, ms: number): unknown {
        return super.setTimeout(fn, ms + 3);
      }
    }
    const clock = new LateClock();
    const rate = 640 * KIB; // A call's room on a 9 Mbit/s uplink.
    const pacer = new Pacer(() => rate, clock);
    let sends: Array<{ t: number; bytes: number }> = [];
    const elapsed = await timed(clock, fineBlock(pacer, clock, 512 * KIB).then((s) => (sends = s)));
    expect((512 * KIB * 1000) / rate / elapsed).toBeGreaterThan(0.97);
    expect(worstBurst(sends, rate)).toBeLessThanOrEqual((rate * FLOW.burstMs) / 1000 + 1);
  });

  it('finishes a started block through a hold at the last rate; the next block waits for the hold to end', async () => {
    const clock = new FakeClock();
    let limit = 256 * KIB;
    const pacer = new Pacer(() => limit, clock);
    await timed(clock, pacer.startBlock());
    await timed(clock, pacer.takeChunk(pacer.chunkBytes(64 * KIB)));

    limit = 0; // A drain holds new writes.
    expect(pacer.chunkBytes(64 * KIB)).toBe(1311);
    const rest = (async () => {
      for (let i = 0; i < 20; i++) await pacer.takeChunk(1311);
    })();
    within(await timed(clock, rest), 100, 0.05);

    let started = false;
    const next = pacer.startBlock().then(() => {
      started = true;
    });
    clock.advance(3_000);
    await flush();
    expect(started).toBe(false);
    limit = 256 * KIB;
    pacer.poke();
    await timed(clock, next);
    expect(started).toBe(true);
  });

  it('in a hidden tab lets out what the late timers owe, up to 250 ms of the budget; 10 ms again once visible', async () => {
    const visibility = new FakeVisibility();
    const clock = new ThrottledClock(visibility);
    const rate = 100 * KIB;
    const pacer = new Pacer(() => rate, clock, visibility);
    const largestBurst = (sends: ReadonlyArray<{ t: number; bytes: number }>) => {
      const at = new Map<number, number>();
      for (const s of sends) at.set(s.t, (at.get(s.t) ?? 0) + s.bytes);
      return Math.max(...at.values());
    };

    visibility.set(false);
    let hidden: Array<{ t: number; bytes: number }> = [];
    await timed(clock, fineBlock(pacer, clock, 64 * KIB).then((s) => (hidden = s)));
    expect(largestBurst(hidden)).toBe(0.25 * rate);

    visibility.set(true);
    let visible: Array<{ t: number; bytes: number }> = [];
    await timed(clock, fineBlock(pacer, clock, 64 * KIB).then((s) => (visible = s)));
    expect(largestBurst(visible)).toBe(KIB);
  });

  it('re-checks on a poke, between throttled wake-ups', async () => {
    const visibility = new FakeVisibility();
    const clock = new ThrottledClock(visibility);
    const rate = 100 * KIB;
    const pacer = new Pacer(() => rate, clock, visibility);
    visibility.set(false);
    let sent = 0;
    const block = (async () => {
      for (let i = 0; i < 20; i++) {
        await pacer.takeChunk(KIB);
        sent++;
      }
    })();
    await flush();
    clock.advance(300); // Before the throttled timer fires.
    await flush();
    expect(sent).toBe(0);
    pacer.poke(); // An ack or an echo arrived.
    await flush();
    expect(sent).toBeGreaterThan(0);
    await timed(clock, block);
  });
});
