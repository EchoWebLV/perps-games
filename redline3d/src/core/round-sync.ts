export function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

export interface Coalescer {
  /** record the latest desired leverage at wall-time `nowMs` */
  note(lev: number, nowMs: number): void;
  /** sample the clock; emit a clamped lever if the window elapsed AND it changed vs last sent */
  pump(nowMs: number): void;
  /** force the current value out (used right before close) */
  flush(nowMs: number): void;
}

export function createCoalescer(opts: { windowMs: number; emit: (lev: number) => void }): Coalescer {
  let desired: number | null = null;
  let lastSent: number | null = null;
  let lastSampleMs = -Infinity;

  function maybeEmit() {
    if (desired === null) return;
    const lev = clampInt(desired, 10, 1000);
    if (lev !== lastSent) { lastSent = lev; opts.emit(lev); }
  }
  return {
    note(lev, _nowMs) { desired = lev; },
    pump(nowMs) {
      if (nowMs - lastSampleMs < opts.windowMs) return;
      lastSampleMs = nowMs;
      maybeEmit();
    },
    flush(nowMs) { lastSampleMs = nowMs; maybeEmit(); },
  };
}

export interface QueuedAction {
  actionId: string;
  kind: "flip" | "lever";
  dir?: 1 | -1;
  lev?: number;
}

export interface ActionQueue {
  enqueue(a: QueuedAction): void;
  /** resolve once the queue is empty (used before close) */
  drain(): Promise<void>;
}

export function createActionQueue(opts: {
  send: (a: QueuedAction) => Promise<void>;
  maxRetries: number;
  retryDelayMs: number;
  delay?: (ms: number) => Promise<void>;
}): ActionQueue {
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const items: QueuedAction[] = [];
  let running = false;
  let idle: Promise<void> = Promise.resolve();
  let resolveIdle: (() => void) | null = null;

  async function run() {
    if (running) return;
    running = true;
    while (items.length) {
      const a = items[0];
      let ok = false;
      for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try { await opts.send(a); ok = true; break; }
        catch { if (attempt < opts.maxRetries) await delay(opts.retryDelayMs); }
      }
      void ok; // best-effort: on permanent failure we drop and continue
      items.shift();
    }
    running = false;
    resolveIdle?.(); resolveIdle = null;
  }

  return {
    enqueue(a) {
      items.push(a);
      if (!running) { idle = new Promise<void>((res) => (resolveIdle = res)); void run(); }
    },
    drain() { return running ? idle : Promise.resolve(); },
  };
}
