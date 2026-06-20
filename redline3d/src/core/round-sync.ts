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
