import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { median, type CallSpan, type Spread } from './measure';
import { DIRECTIONS, type Direction, type LinkStats } from './netem';

/**
 * One JSON line per bench run in test-results/bench-results.jsonl, kept across runs so modes and
 * builds can be compared (Playwright clears only its own output folder, test-results/bench).
 */
export const RESULTS = 'test-results/bench-results.jsonl';
/** TRACE=1: A's saved Flow traces, kept the same way. */
export const TRACES = 'test-results/bench-traces';

export interface BenchResult {
  /** The bench invocation, stamped by playwright.bench.config.ts. */
  run: string;
  at: string;
  scenario: string;
  call: boolean;
  /** The pacing mode both pages reported; null on builds from before Flow. */
  pacing: string | null;
  /** a → b capacity as set in the emulator (the starting rate when it drifts). */
  linkBitsPerSecond: number;
  files: { bytes: number; seconds: number; bitsPerSecond: number };
  queueMs: Record<Direction, Spread>;
  link: Record<Direction, LinkStats>;
  connections: number;
  /** The transfer second by second. */
  timeline: TimelineSecond[];
  /** With a call: its video alone (the baseline) and during the transfer, per direction. */
  video?: { alone: CallSpan; during: CallSpan; ok: Record<Direction, boolean> };
  /** With a call: the height of A's video, second by second, for a few seconds after the last file (Files first lifts its cap). */
  restore?: number[];
  /** With TRACE=1: A's Flow trace, and when sending started on A's clock (the trace's `t` is on it too). */
  trace?: { file: string; sendingAtMs: number };
}

/** One second of a transfer: the a → b link and its deepest queue, and A's own view of it. */
export interface TimelineSecond {
  t: number;
  linkMbps: number;
  queueMs: number;
  /** The round trip A reads from getStats (what today's pacing and the ping use). */
  rttMs: number | null;
  /** A's inbound RTP loss in that second. */
  lossPercent: number | null;
  /** A's video send rate. */
  videoMbps: number;
  /** A's video sent: frames per second, keyframes, height at the end of the second. */
  sentFps: number;
  keyFrames: number;
  height: number;
  /** Freezes of A's video seen by B that ended in that second. */
  freezesAtB: number;
}

/** The call's share of the link that files are measured against (PLAN.md §2.1: link − 2.5 Mbit/s). */
const CALL_BITS_PER_SECOND = 2_500_000;

export function appendResult(result: Omit<BenchResult, 'run' | 'at'>): void {
  mkdirSync(dirname(RESULTS), { recursive: true });
  appendFileSync(RESULTS, JSON.stringify({ run: process.env.BENCH_RUN ?? '', at: new Date().toISOString(), ...result }) + '\n');
}

const mbit = (bitsPerSecond: number) => (bitsPerSecond / 1e6).toFixed(2);
const pct = (share: number) => `${Math.round(share * 100)} %`;

function describe(group: BenchResult[]): string {
  const first = group[0]!;
  const files = median(group.map((r) => r.files.bitsPerSecond));
  const room = first.call ? first.linkBitsPerSecond - CALL_BITS_PER_SECOND : first.linkBitsPerSecond;
  const queue = DIRECTIONS.map((d) => `${d} p95 ${median(group.map((r) => r.queueMs[d].p95)).toFixed(0)} ms`).join(', ');
  const lines = [
    `${first.scenario} · call ${first.call ? 'on' : 'off'} · pacing ${first.pacing ?? 'pre-flow build'} · ${group.length} run(s)`,
    `  files ${mbit(files)} Mbit/s = ${pct(files / room)} of the link${first.call ? ' − 2.5 Mbit/s' : ''} · queue ${queue}`,
  ];
  const calls = group.flatMap((r) => (r.video ? [r.video] : []));
  for (const d of calls.length ? DIRECTIONS : []) {
    const ratio = (key: 'fps' | 'bitrate') => pct(median(calls.map((c) => (c.alone[d][key] ? c.during[d][key] / c.alone[d][key] : 0))));
    const freezes = median(calls.map((c) => c.during[d].freezeSecondsPerMinute)).toFixed(1);
    lines.push(`  call ${d}: OK ${calls.filter((c) => c.ok[d]).length}/${calls.length} · fps ${ratio('fps')} and bitrate ${ratio('bitrate')} of the call alone · frozen ${freezes} s/min`);
  }
  return lines.join('\n');
}

/** Global teardown: medians per scenario, call and mode over this invocation's runs. */
export default function summary(): void {
  if (!existsSync(RESULTS)) return;
  const rows = readFileSync(RESULTS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BenchResult)
    .filter((r) => r.run === process.env.BENCH_RUN);
  const groups = new Map<string, BenchResult[]>();
  for (const r of rows) {
    const key = `${r.scenario}|${r.call}|${r.pacing}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  if (groups.size) console.log(`\n== Medians of this run (all runs: ${RESULTS})\n${[...groups.values()].map(describe).join('\n')}`);
}
