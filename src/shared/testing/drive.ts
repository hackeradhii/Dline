import type { FakeClock } from './fake-clock';

/** Lets every pending promise callback run, and whatever else is already due on the event loop. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Advances `clock` by `ms` in `stepMs` steps, letting promises settle after each. */
export async function run(clock: FakeClock, ms: number, stepMs = 1): Promise<void> {
  await flush();
  for (const end = clock.now() + ms; clock.now() < end; ) {
    clock.advance(Math.min(stepMs, end - clock.now()));
    await flush();
  }
}

/** Advances `clock` in `stepMs` steps until `done()`; resolves with how long that took. Throws after `limitMs`. */
export async function until(clock: FakeClock, done: () => boolean, { stepMs = 1, limitMs = 300_000 } = {}): Promise<number> {
  const start = clock.now();
  await flush();
  while (!done()) {
    if (clock.now() - start >= limitMs) throw new Error(`still not done after ${limitMs} ms`);
    clock.advance(stepMs);
    await flush();
  }
  return clock.now() - start;
}

/** Resolves with how long `task` took on the fake clock (see `until`). */
export function timed(clock: FakeClock, task: Promise<unknown>, options?: Parameters<typeof until>[2]): Promise<number> {
  let settled = false;
  const settle = (): void => {
    settled = true;
  };
  void task.then(settle, settle);
  return until(clock, () => settled, options);
}

/** The most that went out in any window beyond what `rate` (bytes/s) allows in that window: the largest burst. */
export function worstBurst(sends: ReadonlyArray<{ t: number; bytes: number }>, rate: number): number {
  let worst = 0;
  for (let i = 0; i < sends.length; i++) {
    let bytes = 0;
    for (let j = i; j < sends.length; j++) {
      bytes += sends[j]!.bytes;
      worst = Math.max(worst, bytes - (rate * (sends[j]!.t - sends[i]!.t)) / 1000);
    }
  }
  return worst;
}
