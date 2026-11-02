import { describe, expect, it } from 'vitest';
import { FLOW, TRANSFER } from '../../../shared/config';
import { FakeBottleneck, SimControl, type BottleneckOptions, type SimLane } from '../../../shared/testing/fake-bottleneck';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { alwaysVisible } from '../../../shared/timer';
import { FlowResponder } from './flow-responder';
import { FlowSession } from './flow-session';

/**
 * Dline Flow against a simulated bottleneck (PLAN.md §9.3): the real session, probe, responder,
 * estimators and controller, with the app's pacer reduced to 1 ms steps.
 */

const MBIT = 1_000_000;
const KIB = 1024;
const MARKER_BYTES = 16;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

/**
 * A cellular uplink's own delay: up to `peakMs` extra, a new value every `slotMs` (radio scheduling),
 * caused by no queue of ours. Seeded, so every run sees the same jitter.
 */
function radioJitter(peakMs: number, slotMs = 20): (t: number) => number {
  let seed = 7;
  const next = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const slots = new Map<number, number>();
  return (t) => {
    const slot = Math.floor(t / slotMs);
    if (!slots.has(slot)) slots.set(slot, next() * peakMs);
    return slots.get(slot)!;
  };
}

/**
 * The app's pacer and scheduler in 1 ms steps: under a budget, chunks of about 10 ms of it go to
 * the emptiest lane; with no budget every lane is kept full; while holding, nothing goes. Never
 * faster than the app can read and hash (`appBytesPerSecond`).
 */
class SimSender {
  lastWaitAt = -Infinity;
  on = false;
  #tokens = 0;

  constructor(
    private readonly net: FakeBottleneck,
    private readonly limit: () => number | null,
    private readonly appBytesPerSecond = Infinity,
  ) {}

  step(t: number): void {
    const rate = this.limit();
    if (!this.on || rate === 0) return;
    let app = this.appBytesPerSecond / 1000;
    const emptiest = (): SimLane | undefined =>
      this.net.lanes.filter((lane) => lane.open && lane.bufferedBytes < TRANSFER.laneHighWaterBytes).sort((x, y) => x.bufferedBytes - y.bufferedBytes)[0];
    if (rate === null) {
      for (let lane = emptiest(); lane && app > 0; lane = emptiest()) {
        const bytes = Math.min(16 * KIB, app);
        lane.write(bytes);
        app -= bytes;
      }
      return;
    }
    const chunk = clamp((rate * FLOW.chunkMs) / 1000, FLOW.minPacedChunkBytes, FLOW.pacedChunkBytes);
    this.#tokens = Math.min(Math.max((rate * FLOW.burstMs) / 1000, chunk), this.#tokens + rate / 1000);
    for (let lane = emptiest(); lane && app >= chunk; lane = emptiest()) {
      if (this.#tokens < chunk) {
        this.lastWaitAt = t; // The budget, not the lanes, held it back.
        return;
      }
      lane.write(chunk);
      this.#tokens -= chunk;
      app -= chunk;
    }
  }
}

interface SimOptions {
  net?: Partial<BottleneckOptions>;
  appBytesPerSecond?: number;
}

/** A sender (Flow in charge) and a receiver joined by one simulated bottleneck: 9 Mbit/s, 3 s buffer, 20 ms each way by default. */
function simulate({ net = {}, appBytesPerSecond }: SimOptions = {}) {
  const clock = new FakeClock();
  const received: { count: (bytes: number) => void } = { count: () => undefined };
  const network = new FakeBottleneck(clock, {
    capacityBps: () => 9 * MBIT,
    bufferMs: 3000,
    forwardDelayMs: 20,
    lanes: 4,
    onData: (_lane, bytes) => received.count(bytes),
    ...net,
  });
  const control = SimControl.pair(network);
  const responder = new FlowResponder(control.b, clock);
  received.count = (bytes) => responder.received(bytes);
  const open = () => network.lanes.filter((lane) => lane.open);
  let session: FlowSession | null = null;
  const sender = new SimSender(network, () => session!.selector.limit, appBytesPerSecond);
  session = new FlowSession({
    mode: 'flow',
    control: control.a,
    legacy: { limit: null },
    clock,
    visibility: alwaysVisible,
    mark: (m) =>
      open().map((lane) => {
        lane.write(MARKER_BYTES, () => responder.marked(m, lane.id));
        return lane.id;
      }),
    pacerWaitAt: () => sender.lastWaitAt,
    laneCount: () => open().length,
    changed: () => undefined,
  });
  const flow = session;
  clock.setInterval(() => sender.step(clock.now()), 1);
  const queue: number[] = [];
  clock.setInterval(() => queue.push(network.queueMs), 10);

  return {
    clock,
    network,
    session: flow,
    control,
    /** Files start going out. */
    start(): void {
      sender.on = true;
      flow.sending(true);
    },
    /** Lane `id` closes, as `LanePool` would drop it. */
    closeLane(id: number): void {
      network.closeLane(id);
      flow.laneClosed(id);
    },
    /** Advances `ms`; returns the files' throughput (bits/s) and the queue every 10 ms over that time. */
    run(ms: number): { filesBps: number; queue: number[] } {
      queue.length = 0;
      const before = network.delivered.data;
      clock.advance(ms);
      return { filesBps: ((network.delivered.data - before) * 8 * 1000) / ms, queue: [...queue] };
    },
    /** Someone else's burst lands in the bottleneck: `ms` of backlog at the current capacity. */
    burst(ms: number, capacityBps = 9 * MBIT): void {
      for (let bytes = 0; bytes < (capacityBps / 8000) * ms; bytes += 1200) network.sendForward(1200, () => undefined);
    },
  };
}

type Sim = ReturnType<typeof simulate>;

/** Connected and probed for a while (the base delay is known), then sending. */
function sending(sim: Sim, inputs: Parameters<FlowSession['setInputs']>[0] = {}): Sim {
  sim.session.setInputs({ pathKey: 'path-1', ...inputs });
  sim.run(2_000);
  sim.start();
  return sim;
}

/** How long the queue (sampled every 10 ms) took to fall back under `limit` after first rising to it; 0 if it never did. */
function backUnderMs(queue: readonly number[], limit: number): number {
  const over = queue.findIndex((q) => q >= limit);
  if (over < 0) return 0;
  const under = queue.findIndex((q, i) => i > over && q < limit);
  return under < 0 ? Infinity : under * 10;
}

describe('Dline Flow on a simulated bottleneck', () => {
  it('during a call: a short queue, and files get most of what the call leaves (9 Mbit/s, 3 s buffer, 2.5 Mbit/s video)', () => {
    const sim = sending(simulate({ net: { mediaBps: () => 2.5 * MBIT } }), { callActive: true, videoOn: true, mediaSendBps: 2.5 * MBIT });
    sim.run(10_000);
    const { filesBps, queue } = sim.run(60_000);
    expect(percentile(queue, 0.95)).toBeLessThanOrEqual(45);
    expect(filesBps).toBeGreaterThanOrEqual(0.85 * (9 - 2.5) * MBIT);
  });

  it('during a call on a jittery uplink: files get what the call leaves, not a fraction of the call (field, 2026-11-02)', () => {
    // Phone on 5G during a call: ping 65-90 ms, no real queue, yet files held at 90 KB/s. Radio
    // jitter read as a busy bottleneck while Flow's own budget held files back, so the capacity
    // measured was only what Flow allowed, and the call's share was cut from that again and again.
    const media = 1.7 * MBIT;
    for (const net of [{ capacityBps: () => 9 * MBIT }, { capacityBps: () => 30 * MBIT }]) {
      const sim = sending(simulate({ net: { ...net, mediaBps: () => media, forwardDelayMs: 30, lanes: 15, forwardJitterMs: radioJitter(20) } }), {
        callActive: true,
        videoOn: true,
        mediaSendBps: media,
      });
      sim.run(10_000);
      const { filesBps, queue } = sim.run(60_000);
      const callShare = FLOW.mediaHeadroom * FLOW.videoReserveBps;
      expect(filesBps).toBeGreaterThanOrEqual(0.75 * (net.capacityBps() - callShare));
      expect(percentile(queue, 0.95)).toBeLessThanOrEqual(45);
    }
  });

  it('during a call on a 5G uplink as jittery as measured in the field: files take most of the link, and on a clean link still leave the call its share', () => {
    // Field, 2026-11-02: with nothing of ours queued, 39-61 % of probes saw 15 ms or more of queue.
    // Flow read it as congestion, cut a gentle start to the floor before anything had arrived, and
    // the call's share, cut from its own demand, held files at 32 KB/s on a link carrying 1-2 MB/s.
    const media = 1.5 * MBIT;
    const callShare = FLOW.mediaHeadroom * FLOW.videoReserveBps;
    const call = { callActive: true, videoOn: true, mediaSendBps: media };
    const run = (net: Partial<BottleneckOptions>, idleMs: number) => {
      const sim = simulate({ net: { mediaBps: () => media, forwardDelayMs: 30, lanes: 16, ...net } });
      sim.session.setInputs({ pathKey: 'path-1', ...call });
      sim.run(idleMs);
      sim.start();
      sim.run(10_000);
      return sim.run(60_000);
    };

    const radio = run({ capacityBps: () => 15 * MBIT, forwardJitterMs: radioJitter(60, 100) }, 20_000);
    expect(radio.filesBps).toBeGreaterThanOrEqual(0.25 * (15 * MBIT - callShare));
    expect(percentile(radio.queue, 0.95)).toBeLessThanOrEqual(45);

    const clean = run({ capacityBps: () => 9 * MBIT }, 2_000);
    expect(clean.filesBps).toBeLessThanOrEqual(9 * MBIT - callShare);
    expect(percentile(clean.queue, 0.95)).toBeLessThanOrEqual(45);
  });

  it('during a call on a noisy radio path, a short stall is not taken for the capacity: files keep most of the link (PLAN-RESERVE AC3)', () => {
    // Field, 2026-11-02: a ~0.5 s radio stall set the capacity, and the call's share capped files at
    // 48 KB/s for the rest of the run while the queue was back at 2-10 ms. Here: 0.8 s at 2 Mbit/s,
    // 15 s into the transfer (a deeper stall reads as a deep queue and never set the cap).
    const media = 1.5 * MBIT;
    let stallFrom = Infinity;
    const capacityBps = (t: number) => (t >= stallFrom && t < stallFrom + 800 ? 2 * MBIT : 15 * MBIT);
    const sim = simulate({ net: { capacityBps, mediaBps: () => media, forwardDelayMs: 30, lanes: 16, forwardJitterMs: radioJitter(60, 100) } });
    sim.session.setInputs({ pathKey: 'path-1', callActive: true, videoOn: true, mediaSendBps: media });
    sim.run(20_000);
    stallFrom = sim.clock.now() + 15_000;
    sim.start();
    sim.run(18_000);
    const { filesBps, queue } = sim.run(30_000);
    expect(filesBps).toBeGreaterThanOrEqual(0.25 * (15 * MBIT - FLOW.mediaHeadroom * FLOW.videoReserveBps));
    expect(percentile(queue, 0.95)).toBeLessThanOrEqual(45);
  });

  it('without a call: nearly the whole link, with a short queue', () => {
    const sim = sending(simulate());
    sim.run(10_000);
    const { filesBps, queue } = sim.run(60_000);
    expect(filesBps).toBeGreaterThanOrEqual(0.95 * 9 * MBIT);
    expect(percentile(queue, 0.95)).toBeLessThanOrEqual(90);
  });

  it('the link halves suddenly: the queue is back under target within a second', () => {
    let capacity = 9 * MBIT;
    const sim = sending(simulate({ net: { capacityBps: () => capacity } }));
    sim.run(15_000);
    capacity = 4.5 * MBIT;
    const { queue } = sim.run(1_500);
    expect(backUnderMs(queue, FLOW.targetIdleMs)).toBeLessThanOrEqual(1_000);
    expect(percentile(sim.run(10_000).queue, 0.95)).toBeLessThanOrEqual(90);
  });

  it('a fast link that never queues stays unlimited, apart from brief validation drains', () => {
    const sim = sending(simulate({ net: { capacityBps: () => 1000 * MBIT, bufferMs: 50, forwardDelayMs: 1 }, appBytesPerSecond: 25 * 1024 * 1024 }));
    sim.run(45_000);
    const { records, drains } = sim.session.trace;
    expect(records.filter((r) => r.state === 'controlled')).toEqual([]);
    expect(drains.length).toBeGreaterThan(0);
    expect(drains.reduce((ms, d) => ms + d.end - d.start, 0)).toBeLessThanOrEqual(0.01 * 45_000);
  });

  it('a call starting mid-transfer gets its target and share at once: the queue is under 30 ms within a second', () => {
    let media = 0;
    const sim = sending(simulate({ net: { mediaBps: () => media } }));
    sim.run(20_000);
    media = 2.5 * MBIT;
    sim.session.setInputs({ callActive: true, videoOn: true, mediaSendBps: media });
    const { queue } = sim.run(5_000);
    expect(queue.slice(0, 100).some((q) => q < FLOW.targetCallMs)).toBe(true);
    expect(percentile(queue.slice(100), 0.95)).toBeLessThanOrEqual(45);
  });

  it('the start of a transfer keeps the queue short, call or not: the lanes cannot flood the bottleneck before the first mark', () => {
    // The opening seconds count here (PLAN.md §2.1 measures whole transfers): no settling time.
    const quiet = sending(simulate()).run(10_000);
    expect(percentile(quiet.queue, 0.95)).toBeLessThanOrEqual(150);
    expect(quiet.filesBps).toBeGreaterThanOrEqual(0.85 * 9 * MBIT);

    const call = { callActive: true, videoOn: true, mediaSendBps: 2.5 * MBIT };
    const busy = sending(simulate({ net: { mediaBps: () => 2.5 * MBIT } }), call).run(10_000);
    expect(percentile(busy.queue, 0.95)).toBeLessThanOrEqual(100);
    expect(busy.filesBps).toBeGreaterThanOrEqual(0.75 * (9 - 2.5) * MBIT);
  });

  it('the first transfer during a call starts gently on a far path, and unlimited on a near one', () => {
    const call = { callActive: true, videoOn: true, mediaSendBps: 2.5 * MBIT };
    expect(sending(simulate(), call).session.selector.limit).toBe(FLOW.callStartBytesPerSecond);
    expect(sending(simulate({ net: { forwardDelayMs: 2 } }), call).session.selector.limit).toBeNull();
  });

  describe('base validation (drains)', () => {
    it('a reset during a standing queue: the drain exposes it, and the queue is under target within 2 s', () => {
      const sim = sending(simulate());
      sim.run(15_000);
      sim.burst(500);
      sim.session.setInputs({ pathKey: 'path-2' }); // The estimator starts over while the queue stands.
      const { queue } = sim.run(2_500);
      expect(backUnderMs(queue, FLOW.targetIdleMs)).toBeLessThanOrEqual(2_000);
      expect(sim.session.trace.drains.at(-1)).toMatchObject({ validated: true });
      expect(percentile(sim.run(10_000).queue, 0.95)).toBeLessThanOrEqual(90);
    });

    it('a reset with a large sender backlog: the drain cannot certify it, fails safe, and validates later', () => {
      const sim = sending(simulate({ net: { lanes: 15 } }));
      for (const lane of sim.network.lanes) lane.write(TRANSFER.laneHighWaterBytes); // 15 × 256 KiB queued: 3.5 s at 9 Mbit/s.
      sim.session.setInputs({ pathKey: 'path-2' });
      sim.run(3_500);
      const [first] = sim.session.trace.drains;
      expect(first).toMatchObject({ validated: false });
      expect(first!.end - first!.start).toBe(FLOW.drainMaxMs);
      expect(sim.session.selector.limit).toBeGreaterThan(0); // Released to a positive rate, no longer unlimited.
      sim.run(30_000);
      const drains = sim.session.trace.drains;
      drains.slice(1).forEach((drain, i) => !drains[i]!.validated && expect(drain.start - drains[i]!.end).toBeGreaterThanOrEqual(FLOW.drainRetryMs));
      expect(drains.some((d) => d.validated)).toBe(true);
      expect(percentile(sim.run(10_000).queue, 0.95)).toBeLessThanOrEqual(90);
    });

    it('a lane lost before the drain: the surviving lanes clear it and the base is validated', () => {
      const sim = sending(simulate());
      sim.run(5_000);
      sim.closeLane(2);
      sim.run(500);
      sim.session.setInputs({ pathKey: 'path-2' });
      sim.run(3_000);
      expect(sim.session.trace.drains.at(-1)).toMatchObject({ validated: true });
    });

    it('a lane closing mid-drain fails it safe: a positive rate, no certificate, another try after 5 s', () => {
      const sim = sending(simulate());
      sim.run(10_000);
      sim.burst(400); // Markers will take a while.
      sim.session.setInputs({ pathKey: 'path-2' });
      sim.run(100);
      expect(sim.session.selector.limit).toBe(0); // Holding.
      sim.closeLane(1); // Its packets are still queued; nothing proves they left.
      const failed = sim.session.trace.drains.at(-1)!;
      expect(failed).toMatchObject({ validated: false });
      expect(sim.session.selector.limit).toBeGreaterThan(0);
      sim.run(12_000);
      const next = sim.session.trace.drains.find((d) => d.start > failed.end);
      expect(next!.start - failed.end).toBeGreaterThanOrEqual(FLOW.drainRetryMs);
    });

    it('certifies nothing until every lane has delivered what was sent before its marker', () => {
      const sim = sending(simulate());
      sim.run(5_000);
      const lane = sim.network.lanes[3]!;
      lane.write(1_000_000); // Copies of hedged blocks, a cancelled file's backlog: bytes on one lane.
      sim.session.setInputs({ pathKey: 'path-2' });
      let emptiedAt = Infinity;
      for (let t = 0; t < 4_000 && emptiedAt === Infinity; t += 5) {
        sim.run(5);
        if (lane.bufferedBytes === 0 && lane.inFlightBytes <= MARKER_BYTES) emptiedAt = sim.clock.now();
      }
      sim.run(1_000);
      const drain = sim.session.trace.drains.at(-1)!;
      expect(drain.validated).toBe(true);
      expect(drain.end).toBeGreaterThanOrEqual(emptiedAt);
    });

    it('echoes stopping during a drain: released at the deadline, nothing certified, retried after 5 s, files keep going', () => {
      const sim = sending(simulate());
      sim.run(10_000);
      sim.session.setInputs({ pathKey: 'path-2' });
      sim.run(60);
      sim.control.b.mute.add('flow-echo'); // Markers are still answered; echoes no longer come.
      const { filesBps } = sim.run(3_500);
      const failed = sim.session.trace.drains.at(-1)!;
      expect(failed).toMatchObject({ validated: false });
      expect(failed.end - failed.start).toBe(FLOW.drainMaxMs);
      expect(filesBps).toBeGreaterThan(0);
      expect(sim.session.selector.limit).toBeGreaterThan(0);
      sim.control.b.mute.delete('flow-echo');
      sim.run(12_000);
      const next = sim.session.trace.drains.find((d) => d.start > failed.end);
      expect(next!.start - failed.end).toBeGreaterThanOrEqual(FLOW.drainRetryMs);
    });
  });
});

