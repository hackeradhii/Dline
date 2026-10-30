import type { Browser, Page } from '@playwright/test';
import { Netem, type Scenario } from './netem';
import { routeThrough } from './shim';

/** Raw data-channel lab: N peer connections ("lanes") between two profiles, no app code involved. */

export interface RunResult {
  bytes: number;
  ms: number;
  /** [ms since first byte, bytes so far], one per second. */
  marks: Array<[number, number]>;
}

interface Lab {
  offer(count: number): Promise<RTCSessionDescriptionInit[]>;
  answer(offers: RTCSessionDescriptionInit[]): Promise<RTCSessionDescriptionInit[]>;
  accept(answers: RTCSessionDescriptionInit[]): Promise<void>;
  /** Waits up to `ms` for the lanes to open; returns how many did. */
  opened(ms: number): Promise<number>;
  receive(total: number, maxMs: number): void;
  result(): Promise<RunResult>;
  send(total: number, chunk: number, high: number, low: number): Promise<number>;
}

declare global {
  interface Window {
    lab: Lab;
  }
}

/** Runs in the page. Must be self-contained (it is serialised). */
function installLab(): void {
  const lanes: Array<{ pc: RTCPeerConnection; ch: RTCDataChannel }> = [];
  let pending: Promise<RunResult> | null = null;
  const gathered = (pc: RTCPeerConnection) =>
    new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && resolve());
    });
  const lane = () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const ch = pc.createDataChannel('bulk', { negotiated: true, id: 0, ordered: true });
    ch.binaryType = 'arraybuffer';
    lanes.push({ pc, ch });
    return pc;
  };
  const local = async (pc: RTCPeerConnection) => {
    await gathered(pc);
    return pc.localDescription!.toJSON() as RTCSessionDescriptionInit;
  };
  window.lab = {
    async offer(count) {
      const out: RTCSessionDescriptionInit[] = [];
      for (let i = 0; i < count; i++) {
        const pc = lane();
        await pc.setLocalDescription();
        out.push(await local(pc));
      }
      return out;
    },
    async answer(offers) {
      const out: RTCSessionDescriptionInit[] = [];
      for (const offer of offers) {
        const pc = lane();
        await pc.setRemoteDescription(offer);
        await pc.setLocalDescription();
        out.push(await local(pc));
      }
      return out;
    },
    async accept(answers) {
      await Promise.all(answers.map((answer, i) => lanes[i]!.pc.setRemoteDescription(answer)));
    },
    async opened(ms) {
      const all = Promise.all(lanes.map(({ ch }) => (ch.readyState === 'open' ? undefined : new Promise((r) => ch.addEventListener('open', r, { once: true })))));
      await Promise.race([all, new Promise((r) => setTimeout(r, ms))]);
      return lanes.filter(({ ch }) => ch.readyState === 'open').length;
    },
    receive(total, maxMs) {
      let bytes = 0;
      let first = 0;
      let last = 0;
      let mark = 0;
      const marks: Array<[number, number]> = [];
      pending = new Promise<RunResult>((resolve) => {
        const finish = () => resolve({ bytes, ms: last - first, marks });
        for (const { ch } of lanes) {
          ch.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
            const now = performance.now();
            if (!first) {
              first = mark = now;
              setTimeout(finish, maxMs);
            }
            bytes += data.byteLength;
            last = now;
            if (now - mark >= 1000) {
              mark = now;
              marks.push([Math.round(now - first), bytes]);
            }
            if (bytes >= total) finish();
          };
        }
      });
    },
    result: () => pending!,
    async send(total, chunk, high, low) {
      const buffer = new Uint8Array(chunk);
      for (let i = 0; i < chunk; i += 65536) crypto.getRandomValues(buffer.subarray(i, Math.min(chunk, i + 65536)));
      const open = lanes.filter(({ ch }) => ch.readyState === 'open');
      for (const { ch } of open) ch.bufferedAmountLowThreshold = low;
      const start = performance.now();
      for (let sent = 0; sent < total; ) {
        let best: RTCDataChannel | null = null;
        for (const { ch } of open) if (ch.bufferedAmount < high && (!best || ch.bufferedAmount < best.bufferedAmount)) best = ch;
        if (!best) {
          await Promise.race(open.map(({ ch }) => new Promise((r) => ch.addEventListener('bufferedamountlow', r, { once: true }))));
          continue;
        }
        const n = Math.min(chunk, total - sent);
        best.send(n === chunk ? buffer : buffer.subarray(0, n));
        sent += n;
      }
      return performance.now() - start;
    },
  };
}

export interface LabPair {
  a: Page;
  b: Page;
  netem: Netem | null;
  /** Lanes that actually opened. */
  open: number;
  close(): Promise<void>;
}

/** Two profiles (two "devices"), optionally joined only through the emulator. */
export async function labPair(browser: Browser, scenario: Scenario | null, lanes: number): Promise<LabPair> {
  const netem = scenario ? new Netem(scenario) : null;
  const [ctxA, ctxB] = await Promise.all([browser.newContext(), browser.newContext()]);
  if (netem) await Promise.all([routeThrough(ctxA, 'a', netem), routeThrough(ctxB, 'b', netem)]);
  await Promise.all([ctxA.addInitScript(installLab), ctxB.addInitScript(installLab)]);
  const [a, b] = await Promise.all([ctxA.newPage(), ctxB.newPage()]);
  await Promise.all([a.goto('about:blank'), b.goto('about:blank')]);
  const offers = await a.evaluate((n) => window.lab.offer(n), lanes);
  const answers = await b.evaluate((o) => window.lab.answer(o), offers);
  await a.evaluate((x) => window.lab.accept(x), answers);
  const [open] = await Promise.all([a.evaluate(() => window.lab.opened(20_000)), b.evaluate(() => window.lab.opened(20_000))]);
  return {
    a,
    b,
    netem,
    open,
    close: async () => {
      await Promise.all([ctxA.close(), ctxB.close()]);
      await netem?.close();
    },
  };
}

/** Sends `total` bytes a → b over all lanes; stops measuring after `maxMs`. */
/** Defaults mirror the app's per-lane watermarks. */
export async function run(pair: LabPair, total: number, chunk: number, maxMs: number, high = 1 << 20, low = 256 << 10): Promise<RunResult> {
  await pair.b.evaluate(({ total, maxMs }) => window.lab.receive(total, maxMs), { total, maxMs });
  void pair.a.evaluate((x) => window.lab.send(x.total, x.chunk, x.high, x.low), { total, chunk, high, low }).catch(() => undefined);
  return pair.b.evaluate(() => window.lab.result());
}

export const mbps = (r: RunResult): number => (r.ms > 0 ? r.bytes / 1024 / 1024 / (r.ms / 1000) : 0);
