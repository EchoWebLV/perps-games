export interface ReconnectLoop {
  schedule(retry: () => void): void;
  reset(): void;
}

type TimerId = number;

export interface ReconnectLoopOpts {
  setTimeout?: (callback: () => void, delayMs: number) => TimerId;
  clearTimeout?: (timer: TimerId) => void;
  delayMs?: number;
}

export function createReconnectLoop(opts: ReconnectLoopOpts = {}): ReconnectLoop {
  const setTimer = opts.setTimeout ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearTimer = opts.clearTimeout ?? ((timer) => window.clearTimeout(timer));
  const delayMs = opts.delayMs ?? 1000;
  let timer: TimerId | null = null;

  return {
    schedule(retry) {
      if (timer != null) return;
      timer = setTimer(() => {
        timer = null;
        retry();
      }, delayMs);
    },
    reset() {
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
