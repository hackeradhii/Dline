/** Promise helpers shared across modules (DRY). */

/** Exponential backoff delay with full jitter. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  return Math.round(random() * Math.min(maxMs, baseMs * 2 ** attempt));
}

/** Runs async tasks strictly one after another, in submission order. */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
