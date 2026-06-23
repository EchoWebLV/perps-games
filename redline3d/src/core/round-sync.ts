import { ApiError, type Api, type Asset, type Dir, type OpenResult, type CloseResult } from "./api";
import { type KvStore } from "./identity";

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

export interface Clock { now(): number; }

const ROUND_KEY = "redline.round.v1";

export interface RoundSync {
  open(p: { asset: Asset; dir: Dir; lev: number; stake: number }): Promise<OpenResult | null>;
  noteLeverage(lev: number): void;
  noteFlip(dir: Dir): void;
  /** call each animation frame with the wall clock advanced; pumps the coalescer */
  pump(): void;
  close(reason: "cashout" | "expire"): Promise<CloseResult | null>;
  /** boot: settle any dangling open round (from /v1/me openRoundId or persisted id) */
  recover(openRoundId: string | null): Promise<void>;
  /**
   * Mid-session self-heal: a GO was blocked by a dangling local round (a prior close that
   * couldn't settle). Ask the server what's true — settle the round if it's still open, or
   * clear the local id if the server already settled it. "cleared" = safe to open a fresh
   * round; "blocked" = still unsettleable (halted feed / unreachable) — leave it for a retry.
   */
  reconcile(): Promise<"cleared" | "blocked">;
  roundId(): string | null;
  isOpening(): boolean;
}

export function createRoundSync(deps: {
  api: Api; clock: Clock; store: KvStore;
  coalesceMs?: number; actionMaxRetries?: number; actionRetryMs?: number;
  closeBackoffMs?: number[]; delay?: (ms: number) => Promise<void>;
}): RoundSync {
  const { api, clock, store } = deps;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const closeBackoff = deps.closeBackoffMs ?? [500, 1000, 2000, 4000, 8000];
  let roundId: string | null = store.get(ROUND_KEY);
  let opening = false;

  const queue = createActionQueue({
    send: (a) => api.roundAction({ roundId: roundId!, actionId: a.actionId, kind: a.kind, dir: a.dir, lev: a.lev }),
    maxRetries: deps.actionMaxRetries ?? 3,
    retryDelayMs: deps.actionRetryMs ?? 250,
    delay,
  });
  const coalescer = createCoalescer({
    windowMs: deps.coalesceMs ?? 200,
    emit: (lev) => queue.enqueue({ actionId: crypto.randomUUID(), kind: "lever", lev }),
  });

  function setRound(id: string | null) {
    roundId = id;
    if (id) store.set(ROUND_KEY, id); else store.set(ROUND_KEY, "");
  }
  const isFeedHalt = (e: unknown) => e instanceof ApiError ? e.code === "feed_halt" : (e as any)?.code === "feed_halt";
  const isNotFound = (e: unknown) => e instanceof ApiError ? e.code === "round_not_found" : (e as any)?.code === "round_not_found";

  // Shared settle path: flush pending levers, drain the action queue, then close with backoff.
  // Clears the local round ONLY when the server confirms it's gone (settled OR not_found). On a
  // halted feed it deliberately KEEPS the id so 1.4 / a later retry can finish it (see close() test).
  //
  // SINGLE-FLIGHT + id-capture: settle the round that was current at ENTRY (`id`), never whatever
  // `roundId` later becomes. A backoff-parked settle of an old round must not close — nor null the
  // local id of — a round opened afterward. settleInFlight makes a second, overlapping settle a no-op.
  let settleInFlight = false;
  async function settle(reason: "cashout" | "expire"): Promise<CloseResult | null> {
    const id = roundId;
    if (!id || settleInFlight) return null;
    settleInFlight = true;
    try {
      coalescer.flush(clock.now());                 // force any pending lever into the queue
      await queue.drain();                          // ensure the server has the full segment set
      for (let i = 0; i <= closeBackoff.length; i++) {
        try {
          const res = await api.closeRound({ roundId: id, reason });
          if (roundId === id) setRound(null);       // only clear if we're still on the round we closed
          return res;
        } catch (e) {
          if (isFeedHalt(e)) return null;           // server cannot settle on a halted feed -> 1.4
          if (isNotFound(e)) { if (roundId === id) setRound(null); return null; } // already gone -> clear
          if (i < closeBackoff.length) await delay(closeBackoff[i]);
        }
      }
      return null;                                  // transport gave up; stays open for reload/1.4
    } finally { settleInFlight = false; }
  }

  let reconciling = false;

  return {
    isOpening: () => opening,
    roundId: () => roundId || null,
    noteLeverage(lev) { if (roundId) coalescer.note(lev, clock.now()); },
    noteFlip(dir) { if (roundId) queue.enqueue({ actionId: crypto.randomUUID(), kind: "flip", dir }); },
    pump() { if (roundId) coalescer.pump(clock.now()); },

    async open(p) {
      if (opening || roundId) return null;            // re-entrancy + single-round guard
      opening = true;
      try {
        const out = await api.openRound(p);
        setRound(out.roundId);
        return out;
      } finally { opening = false; }
    },

    close: (reason) => settle(reason),

    async reconcile() {
      if (opening || reconciling) return "blocked";   // an open / another reconcile is mid-flight
      if (!roundId) return "cleared";                  // nothing dangling
      reconciling = true;
      try {
        let serverOpen: string | null;
        try { serverOpen = (await api.me()).openRoundId; }
        catch { return "blocked"; }                    // can't reach the server — keep the id, retry later
        if (serverOpen !== roundId) { setRound(null); return "cleared"; } // server already settled it
        await settle("expire");                        // still open server-side -> settle it now
        return roundId ? "blocked" : "cleared";
      } finally { reconciling = false; }
    },

    async recover(openRoundId) {
      const id = openRoundId ?? roundId;
      if (!id) return;
      setRound(id);
      await settle("expire"); // backoff close; clears on settle/not_found, keeps it on a halted feed
    },
  };
}
