/** Promise helpers shared across modules (DRY). */

export interface EventSource {
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Resolves the next time `target` fires `type`. */
export function once(target: EventSource, type: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      target.removeEventListener(type, onEvent);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const onEvent = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    if (signal?.aborted) return onAbort();
    target.addEventListener(type, onEvent, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Rejects with TimeoutError if `promise` hasn't settled in `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

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
