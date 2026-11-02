import type { Page } from '@playwright/test';
import { performance } from 'node:perf_hooks';
import { DIRECTIONS, type Direction, type Netem, type Side } from './netem';

/** Bench measurements: the emulator's link (queue and throughput), and each page's own view. */

/** Nearest-rank percentile; 0 when there are no values. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export const median = (values: readonly number[]): number => percentile(values, 0.5);

export interface Spread {
  p50: number;
  p95: number;
  max: number;
}

const spread = (values: readonly number[]): Spread => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.reduce((m, v) => Math.max(m, v), 0),
});

/** One second of the link, both directions: throughput and the deepest queue seen. */
export type LinkSecond = Record<Direction, { mbps: number; queueMaxMs: number }>;

/**
 * Samples the emulator's backlog in both directions every `everyMs` (the ground truth for
 * queueing delay), and its throughput once a second.
 */
export class QueueSampler {
  readonly #samples: Record<Direction, number[]> = { aToB: [], bToA: [] };
  readonly #seconds: LinkSecond[] = [];
  readonly #timer: NodeJS.Timeout;
  readonly #start = performance.now();
  #bytes: Record<Direction, number>;
  #deepest: Record<Direction, number> = { aToB: 0, bToA: 0 };

  constructor(netem: Netem, everyMs = 50) {
    this.#bytes = this.#totals(netem);
    this.#timer = setInterval(() => {
      for (const d of DIRECTIONS) {
        const queue = netem.queueDelayMs(d);
        this.#samples[d].push(queue);
        this.#deepest[d] = Math.max(this.#deepest[d], queue);
      }
      if (performance.now() - this.#start >= (this.#seconds.length + 1) * 1000) this.#closeSecond(netem);
    }, everyMs);
  }

  /** Stops sampling (safe to call again) and returns the queue in ms per direction. */
  stop(): Record<Direction, Spread> {
    clearInterval(this.#timer);
    return { aToB: spread(this.#samples.aToB), bToA: spread(this.#samples.bToA) };
  }

  /** The link second by second since sampling started. */
  get seconds(): readonly LinkSecond[] {
    return this.#seconds;
  }

  #totals(netem: Netem): Record<Direction, number> {
    const stats = netem.stats();
    return { aToB: stats.aToB.bytes, bToA: stats.bToA.bytes };
  }

  #closeSecond(netem: Netem): void {
    const bytes = this.#totals(netem);
    const second = (d: Direction) => ({ mbps: ((bytes[d] - this.#bytes[d]) * 8) / 1e6, queueMaxMs: this.#deepest[d] });
    this.#seconds.push({ aToB: second('aToB'), bToA: second('bToA') });
    this.#bytes = bytes;
    this.#deepest = { aToB: 0, bToA: 0 };
  }
}

/** One reading of a page's main connection. */
interface PageSample {
  at: number;
  /** The selected candidate pair's round trip in ms (what the app's pacing and ping read), or null. */
  rttMs: number | null;
  /** Inbound RTP packets lost and received so far (audio and video). */
  lost: number;
  received: number;
  /** Video bytes sent so far, and the height being sent (0 while none). */
  sentBytes: number;
  height: number;
  /** Video frames and keyframes sent so far. */
  framesSent: number;
  keyFrames: number;
  /** The video received: frames per second, freezes so far. */
  fps: number;
  freezes: number;
  freezeSeconds: number;
  /** Seconds so far the video sender's quality was limited, by reason (`outbound-rtp.qualityLimitationDurations`). */
  limited: Limitation;
}

/** What limited the video sender's quality: seconds (in a sample) or a share of the span (in `VideoStats`). */
export interface Limitation {
  cpu: number;
  bandwidth: number;
  other: number;
}

declare global {
  interface Window {
    __pageSamples?: PageSample[];
  }
}

/** Runs in the page (it is serialised, so it must be self-contained): samples the main connection. */
function samplePage(everyMs: number): void {
  const samples: PageSample[] = (window.__pageSamples = []);
  setInterval(() => {
    // The first connection the shim saw is the main one (pairing happens before any lane opens).
    const pc = [...(window.__peers ?? [])][0];
    void pc
      ?.getStats()
      .then((report) => {
        const sample: PageSample = {
          at: performance.now(),
          rttMs: null,
          lost: 0,
          received: 0,
          sentBytes: 0,
          height: 0,
          framesSent: 0,
          keyFrames: 0,
          fps: 0,
          freezes: 0,
          freezeSeconds: 0,
          limited: { cpu: 0, bandwidth: 0, other: 0 },
        };
        const stats = [...(report as unknown as Map<string, Record<string, unknown>>).values()];
        const pairId = stats.find((s) => s.type === 'transport')?.selectedCandidatePairId;
        const pair = stats.find((s) => s.id === pairId);
        if (typeof pair?.currentRoundTripTime === 'number') sample.rttMs = pair.currentRoundTripTime * 1000;
        const n = (value: unknown) => (typeof value === 'number' ? value : 0);
        for (const s of stats) {
          if (s.type === 'inbound-rtp') {
            sample.lost += n(s.packetsLost);
            sample.received += n(s.packetsReceived);
          }
          if (s.kind !== 'video') continue;
          if (s.type === 'outbound-rtp') {
            sample.sentBytes += n(s.bytesSent);
            sample.height = Math.max(sample.height, n(s.frameHeight));
            sample.framesSent += n(s.framesSent);
            sample.keyFrames += n(s.keyFramesEncoded);
            const limited = (s.qualityLimitationDurations ?? {}) as Record<string, unknown>;
            sample.limited = { cpu: n(limited.cpu), bandwidth: n(limited.bandwidth), other: n(limited.other) };
          }
          if (s.type === 'inbound-rtp') {
            sample.fps += n(s.framesPerSecond);
            sample.freezes += n(s.freezeCount);
            sample.freezeSeconds += n(s.totalFreezesDuration);
          }
        }
        samples.push(sample);
      })
      .catch(() => undefined);
  }, everyMs);
}

/** One direction of the call over a span: what its sender sent and what its receiver showed. */
export interface VideoStats {
  /** Median of the sender's video bitrate, bits/s. */
  bitrate: number;
  /** Median height of the video sent (720 = the camera's full size). */
  height: number;
  /** Median of the receiver's frames per second. */
  fps: number;
  freezes: number;
  /** Seconds frozen per minute of the span. */
  freezeSecondsPerMinute: number;
  /** Share of the span the sender's quality was limited, by reason (0-1). */
  limited: Limitation;
}

export type CallSpan = Record<Direction, VideoStats>;

const bitsPerSecond = (from: PageSample, to: PageSample) => ((to.sentBytes - from.sentBytes) * 8 * 1000) / (to.at - from.at);

function videoStats(sent: PageSample[], received: PageSample[]): VideoStats {
  const first = received[0];
  const last = received.at(-1);
  const minutes = first && last ? (last.at - first.at) / 60_000 : 0;
  const [from, to] = [sent[0], sent.at(-1)];
  const seconds = from && to ? (to.at - from.at) / 1000 : 0;
  const share = (reason: keyof Limitation) => (from && to && seconds > 0 ? Math.max(0, to.limited[reason] - from.limited[reason]) / seconds : 0);
  return {
    bitrate: median(sent.slice(1).map((s, i) => bitsPerSecond(sent[i]!, s))),
    height: median(sent.map((s) => s.height)),
    fps: median(received.map((s) => s.fps)),
    freezes: first && last ? last.freezes - first.freezes : 0,
    freezeSecondsPerMinute: first && last && minutes > 0 ? (last.freezeSeconds - first.freezeSeconds) / minutes : 0,
    limited: { cpu: share('cpu'), bandwidth: share('bandwidth'), other: share('other') },
  };
}

/** One second of A's own view: the round trip it reads, its inbound loss and its video rate. */
export interface PageSecond {
  rttMs: number | null;
  lossPercent: number | null;
  videoMbps: number;
  /** The video sent: frames per second, keyframes, and its height at the end of the second. */
  sentFps: number;
  keyFrames: number;
  height: number;
  /** Freezes of the video received that ended in that second. */
  freezes: number;
}

/** A moment on both pages' own clocks (each page has its own time origin). */
export type Mark = Record<Side, number>;

/** Samples both pages' main connection every `everyMs`, summarised between marks. */
export class PageProbe {
  private constructor(private readonly pages: Record<Side, Page>) {}

  static async start(a: Page, b: Page, everyMs = 500): Promise<PageProbe> {
    await Promise.all([a.evaluate(samplePage, everyMs), b.evaluate(samplePage, everyMs)]);
    return new PageProbe({ a, b });
  }

  async mark(): Promise<Mark> {
    const [a, b] = await Promise.all([this.pages.a.evaluate(() => performance.now()), this.pages.b.evaluate(() => performance.now())]);
    return { a, b };
  }

  /** Both directions of the call between two marks. */
  async span(from: Mark, to: Mark): Promise<CallSpan> {
    const [a, b] = await Promise.all([this.#within('a', from, to), this.#within('b', from, to)]);
    return { aToB: videoStats(a, b), bToA: videoStats(b, a) };
  }

  /** `side`'s view second by second between two marks. */
  async seconds(side: Side, from: Mark, to: Mark): Promise<PageSecond[]> {
    const samples = await this.#within(side, from, to);
    const seconds: PageSecond[] = [];
    let start = samples[0];
    for (let s = 0, i = 0; start && i < samples.length; s++) {
      let end: PageSample = start;
      while (i < samples.length && samples[i]!.at < from[side] + (s + 1) * 1000) end = samples[i++]!;
      const lost = end.lost - start.lost;
      const total = lost + end.received - start.received;
      const span = (end.at - start.at) / 1000;
      seconds.push({
        rttMs: end.rttMs,
        lossPercent: total > 0 ? (100 * Math.max(0, lost)) / total : null,
        videoMbps: span > 0 ? bitsPerSecond(start, end) / 1e6 : 0,
        sentFps: span > 0 ? (end.framesSent - start.framesSent) / span : 0,
        keyFrames: end.keyFrames - start.keyFrames,
        height: end.height,
        freezes: end.freezes - start.freezes,
      });
      start = end;
    }
    return seconds;
  }

  async #within(side: Side, from: Mark, to: Mark): Promise<PageSample[]> {
    return (await this.pages[side].evaluate(() => window.__pageSamples ?? [])).filter((s) => s.at >= from[side] && s.at <= to[side]);
  }
}

/**
 * "Call OK" (PLAN.md §2.1), per direction, against the same call measured alone: at least 90 % of
 * its frame rate and 80 % of its video bitrate, and at most 1 s frozen per minute.
 */
export const callOk = (alone: VideoStats, during: VideoStats): boolean =>
  during.fps >= 0.9 * alone.fps && during.bitrate >= 0.8 * alone.bitrate && during.freezeSecondsPerMinute <= 1;
