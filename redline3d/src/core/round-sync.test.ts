import { describe, it, expect } from "vitest";
import { clampInt, createCoalescer } from "./round-sync";

describe("clampInt", () => {
  it("clamps and integer-rounds into [10,1000]", () => {
    expect(clampInt(2000, 10, 1000)).toBe(1000); // nitro x2 overflow
    expect(clampInt(5, 10, 1000)).toBe(10);
    expect(clampInt(123.7, 10, 1000)).toBe(124);
  });
});

describe("coalescer (wall-clock, dedup on last-sent)", () => {
  it("emits at most one lever per window, only on a real change", () => {
    const out: number[] = [];
    const c = createCoalescer({ windowMs: 200, emit: (lev) => out.push(lev) });
    c.note(50, 0); c.pump(0);       // first sample emits the baseline (lastSampleMs starts at -Infinity)
    expect(out).toEqual([50]);
    c.note(50, 10); c.pump(210);    // unchanged vs last-sent -> no emit
    expect(out).toEqual([50]);
    c.note(250, 220); c.pump(250);  // only 40ms since the last sample -> window not elapsed
    expect(out).toEqual([50]);
    c.pump(420);                    // window elapsed -> emit 250
    expect(out).toEqual([50, 250]);
    c.note(300, 430); c.note(250, 440); c.pump(640); // blip-revert back to 250 (== last-sent) -> no emit
    expect(out).toEqual([50, 250]);
  });

  it("clamps the emitted value", () => {
    const out: number[] = [];
    const c = createCoalescer({ windowMs: 200, emit: (lev) => out.push(lev) });
    c.note(2000, 0); c.pump(200);
    expect(out).toEqual([1000]);
  });
});

import { createActionQueue } from "./round-sync";

describe("action queue (sequential, idempotent, ordered)", () => {
  it("sends one POST at a time in enqueue order, reusing actionId on retry", async () => {
    const calls: { actionId: string; kind: string }[] = [];
    let failFirst = true;
    const q = createActionQueue({
      send: async (a) => {
        calls.push({ actionId: a.actionId, kind: a.kind });
        if (a.kind === "lever" && failFirst) { failFirst = false; throw new Error("net"); }
      },
      maxRetries: 3, retryDelayMs: 0, delay: () => Promise.resolve(),
    });
    q.enqueue({ actionId: "id-lever", kind: "lever", lev: 100 });
    q.enqueue({ actionId: "id-flip", kind: "flip", dir: -1 });
    await q.drain();
    // lever was retried with the SAME id, then flip — order preserved
    expect(calls.map((c) => c.actionId)).toEqual(["id-lever", "id-lever", "id-flip"]);
  });

  it("drops an action after maxRetries and continues", async () => {
    const sent: string[] = [];
    const q = createActionQueue({
      send: async (a) => { if (a.kind === "lever") throw new Error("net"); sent.push(a.actionId); },
      maxRetries: 2, retryDelayMs: 0, delay: () => Promise.resolve(),
    });
    q.enqueue({ actionId: "bad", kind: "lever", lev: 100 });
    q.enqueue({ actionId: "ok", kind: "flip", dir: 1 });
    await q.drain();
    expect(sent).toEqual(["ok"]); // bad dropped, ok still sent
  });
});

import { createRoundSync } from "./round-sync";
import type { Api } from "./api";

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    me: async () => ({ userId: "u", balance: 100, cars: [], openRoundId: null }),
    openRound: async (p) => ({ roundId: "R", asset: p.asset, dir: p.dir, lev: p.lev, stake: p.stake, entryRaw: 100, entryTsUs: 5_000_000 }),
    roundAction: async () => {},
    closeRound: async () => ({ outcome: "cashout", payoutCoins: 7, pnlCoins: 2, equity: 1.4, exitRaw: 101, balance: 107 }),
    markRound: async () => ({ status: "open", stale: false, outcome: "cashout", equity: 1.4, payoutCoins: 7, buffer: 1 }),
    depositBuild: async () => ({ txBase64: "" }),
    walletBalance: async () => ({ wallet: null, balance: 0 }),
    ...over,
  };
}
const store = () => { const m = new Map<string,string>(); return { get: (k:string)=>m.get(k)??null, set:(k:string,v:string)=>{m.set(k,v);} }; };
const clock = (t = { now: 0 }) => ({ now: () => t.now });

describe("round-sync session", () => {
  it("open() is re-entrant-guarded: two concurrent calls -> one POST", async () => {
    let opens = 0;
    const rs = createRoundSync({ api: fakeApi({ openRound: async (p) => { opens++; return { roundId: "R", asset: p.asset, dir: p.dir, lev: p.lev, stake: p.stake, entryRaw: 100, entryTsUs: 0 }; } }), clock: clock(), store: store() });
    const [a, b] = await Promise.all([
      rs.open({ asset: "SOL", dir: 1, lev: 50, stake: 5 }),
      rs.open({ asset: "SOL", dir: 1, lev: 50, stake: 5 }),
    ]);
    expect(opens).toBe(1);
    expect(a?.roundId ?? b?.roundId).toBe("R");
  });

  it("close() flushes a pending lever then settles, returning the server result", async () => {
    const actions: string[] = [];
    const api = fakeApi({ roundAction: async (a) => { actions.push(a.kind + ":" + (a.lev ?? a.dir)); } });
    const t = { now: 0 };
    const rs = createRoundSync({ api, clock: clock(t), store: store() });
    await rs.open({ asset: "SOL", dir: 1, lev: 50, stake: 5 });
    rs.noteLeverage(120); t.now = 0; rs.pump(); // no window yet
    const res = await rs.close("cashout");      // must force-flush 120 before settling
    expect(actions).toContain("lever:120");
    expect(res?.balance).toBe(107);
    expect(rs.roundId()).toBeNull();            // cleared after settle
  });

  it("close() on feed_halt gives up to settling (no infinite retry)", async () => {
    const api = fakeApi({ closeRound: async () => { const e: any = new Error("feed_halt"); e.code = "feed_halt"; throw e; } });
    const rs = createRoundSync({ api, clock: clock(), store: store(), closeBackoffMs: [0, 0] });
    await rs.open({ asset: "SOL", dir: 1, lev: 50, stake: 5 });
    const res = await rs.close("expire");
    expect(res).toBeNull();          // surfaced as unsettled
    expect(rs.roundId()).not.toBeNull(); // stays open for 1.4 + reload recovery
  });

  // Regression: bail → close couldn't settle (feed halt / lost response) leaves a stale local
  // roundId. Without mid-session reconciliation the next GO silently no-ops on open()'s single-round
  // guard and the UI sticks on "Launching…". reconcile() is the self-heal the GO handler calls.
  it("reconcile() clears a stale local round the server already settled", async () => {
    const api = fakeApi({ me: async () => ({ userId: "u", balance: 100, cars: [], openRoundId: null }) });
    const rs = createRoundSync({ api, clock: clock(), store: store() });
    await rs.open({ asset: "SOL", dir: 1, lev: 50, stake: 5 }); // local roundId = "R"
    expect(rs.roundId()).toBe("R");
    const r = await rs.reconcile();                              // server has no open round
    expect(r).toBe("cleared");
    expect(rs.roundId()).toBeNull();                            // safe to open a fresh round
  });

  it("reconcile() settles a still-open dangling round, then clears", async () => {
    let closed = 0;
    const api = fakeApi({
      me: async () => ({ userId: "u", balance: 100, cars: [], openRoundId: "R" }),
      closeRound: async () => { closed++; return { outcome: "expire", payoutCoins: 0, pnlCoins: 0, equity: 0.5, exitRaw: 99, balance: 100 }; },
    });
    const rs = createRoundSync({ api, clock: clock(), store: store() });
    await rs.open({ asset: "SOL", dir: 1, lev: 50, stake: 5 });
    const r = await rs.reconcile();
    expect(closed).toBe(1);
    expect(r).toBe("cleared");
    expect(rs.roundId()).toBeNull();
  });

  it("reconcile() stays blocked (keeps the round) when it can't settle on a halted feed", async () => {
    const api = fakeApi({
      me: async () => ({ userId: "u", balance: 100, cars: [], openRoundId: "R" }),
      closeRound: async () => { const e: any = new Error("feed_halt"); e.code = "feed_halt"; throw e; },
    });
    const rs = createRoundSync({ api, clock: clock(), store: store(), closeBackoffMs: [0, 0] });
    await rs.open({ asset: "SOL", dir: 1, lev: 50, stake: 5 });
    const r = await rs.reconcile();
    expect(r).toBe("blocked");
    expect(rs.roundId()).not.toBeNull();
  });

  it("reconcile() reports blocked and keeps the round when the server is unreachable", async () => {
    const api = fakeApi({ me: async () => { throw new Error("offline"); } });
    const rs = createRoundSync({ api, clock: clock(), store: store() });
    await rs.open({ asset: "SOL", dir: 1, lev: 50, stake: 5 });
    const r = await rs.reconcile();
    expect(r).toBe("blocked");
    expect(rs.roundId()).toBe("R");
  });

  it("recover() settles with backoff and never throws on a halted feed", async () => {
    const api = fakeApi({ closeRound: async () => { const e: any = new Error("feed_halt"); e.code = "feed_halt"; throw e; } });
    const rs = createRoundSync({ api, clock: clock(), store: store(), closeBackoffMs: [0, 0] });
    await expect(rs.recover("R")).resolves.toBeUndefined();
    expect(rs.roundId()).not.toBeNull(); // unsettled on a halt → kept for the next retry
  });

  it("settle() is single-flight: an overlapping close() no-ops instead of racing a second close", async () => {
    // Regression (adversarial review): a backoff-parked settle from an old round must not also
    // close/clear a round opened later. Single-flight makes the overlapping settle a no-op.
    let closes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const api = fakeApi({
      closeRound: async () => { closes++; await gate; return { outcome: "cashout", payoutCoins: 7, pnlCoins: 2, equity: 1.4, exitRaw: 101, balance: 107 }; },
    });
    const rs = createRoundSync({ api, clock: clock(), store: store() });
    await rs.open({ asset: "SOL", dir: 1, lev: 50, stake: 5 });
    const p1 = rs.close("cashout");   // enters settle, parks inside closeRound on the gate
    const p2 = rs.close("cashout");   // overlapping — must no-op, not start a 2nd close
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(closes).toBe(1);                                   // exactly one real close happened
    expect([r1, r2].filter((x) => x === null).length).toBe(1); // the overlapping call no-opped
    expect([r1, r2].filter((x) => x?.balance === 107).length).toBe(1);
    expect(rs.roundId()).toBeNull();
  });

  it("recover() clears the local round when the server reports it already gone", async () => {
    const api = fakeApi({ closeRound: async () => { const e: any = new Error("round_not_found"); e.code = "round_not_found"; throw e; } });
    const rs = createRoundSync({ api, clock: clock(), store: store(), closeBackoffMs: [0, 0] });
    await rs.recover("R");
    expect(rs.roundId()).toBeNull();
  });
});
