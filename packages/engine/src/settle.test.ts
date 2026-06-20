import { describe, it, expect } from "vitest";
import { settleRound, type SettleInput, type Action } from "./settle";
import { BASE_CONFIG } from "./config";

const T0 = 1_000_000_000; // arbitrary fixed oracle ts in µs (no clock in pure tests)

function base(over: Partial<SettleInput> = {}): SettleInput {
  return {
    openDir: 1,
    openLev: 10,
    entryRaw: 100,
    entryTsUs: T0,
    stake: 10,
    actions: [],
    exitRaw: 100,
    exitTsUs: T0 + 1_000_000, // +1s
    cfg: BASE_CONFIG,
    ...over,
  };
}

describe("settleRound", () => {
  it("break-even cashout pays stake minus the house edge", () => {
    const r = settleRound(base());
    expect(r.outcome).toBe("cashout");
    expect(r.equity).toBe(1);
    expect(r.payoutCoins).toBe(Math.floor(10 * 1 * 0.95)); // 9
    expect(r.pnlCoins).toBe(r.payoutCoins - 10);
  });

  it("long win is linear-from-entry (reuses equityOf exactly)", () => {
    const r = settleRound(base({ openLev: 10, entryRaw: 100, exitRaw: 101 }));
    // eq = 1 + 10*(101/100 - 1) = 1.1
    expect(r.equity).toBeCloseTo(1.1, 9);
    expect(r.payoutCoins).toBe(Math.floor(10 * 1.1 * 0.95)); // 10
  });

  it("short win: direction sign respected", () => {
    const r = settleRound(base({ openDir: -1, openLev: 10, entryRaw: 100, exitRaw: 99 }));
    // eq = 1 + (-1)*10*(99/100 - 1) = 1.1
    expect(r.equity).toBeCloseTo(1.1, 9);
  });

  it("liquidation forfeits the stake, never negative payout", () => {
    // long, lev 10: eq <= 0.2 needs price <= 92 → 1 + 10*(92/100-1) = 0.2
    const r = settleRound(base({ openLev: 10, entryRaw: 100, exitRaw: 91 }));
    expect(r.outcome).toBe("liq");
    expect(r.equity).toBe(0);
    expect(r.payoutCoins).toBe(0);
    expect(r.pnlCoins).toBe(-10);
  });

  it("cap clamps the win to CAP", () => {
    // lev 10: eq >= 25 needs price >= 340 → 1 + 10*(340/100-1) = 25
    const r = settleRound(base({ openLev: 10, entryRaw: 100, exitRaw: 400 }));
    expect(r.outcome).toBe("cap");
    expect(r.equity).toBe(BASE_CONFIG.CAP);
    expect(r.payoutCoins).toBe(Math.floor(10 * 25 * 0.95)); // 237
  });

  it("time outcome settles at the live equity when the cap elapsed", () => {
    const r = settleRound(
      base({ openLev: 10, entryRaw: 100, exitRaw: 101, exitTsUs: T0 + 60_000_000 }),
    );
    expect(r.outcome).toBe("time");
    expect(r.equity).toBeCloseTo(1.1, 9);
  });

  it("precedence: liq beats time when both trigger at the exit mark", () => {
    const r = settleRound(
      base({ openLev: 10, entryRaw: 100, exitRaw: 91, exitTsUs: T0 + 120_000_000 }),
    );
    expect(r.outcome).toBe("liq");
    expect(r.equity).toBe(0);
  });

  it("payout/pnl are always integers (no fractional coins stored)", () => {
    const r = settleRound(base({ stake: 7, openLev: 33, entryRaw: 100, exitRaw: 100.7 }));
    expect(Number.isInteger(r.payoutCoins)).toBe(true);
    expect(Number.isInteger(r.pnlCoins)).toBe(true);
  });

  it("payout floors (house-favorable, never a free coin from rounding)", () => {
    // craft a fractional payout: stake 3, eq ~1 → 3*1*0.95 = 2.85 → floor 2
    const r = settleRound(base({ stake: 3, openLev: 10, entryRaw: 100, exitRaw: 100 }));
    expect(r.payoutCoins).toBe(2);
  });

  it("config isolation: different cfg.CAP yields independent results (no global bleed)", () => {
    const tight = { ...BASE_CONFIG, CAP: 2 };
    const r = settleRound(base({ openLev: 10, entryRaw: 100, exitRaw: 400, cfg: tight }));
    expect(r.outcome).toBe("cap");
    expect(r.equity).toBe(2);
  });

  // --- segment-replay (the Clown Car path) ---

  it("a mid-round flip banks the first segment and re-anchors (Clown Car)", () => {
    // long from 100 → flip to short at 110 (banks +1.0), then price falls to 105 → short gains
    const actions: Action[] = [{ kind: "flip", dir: -1, priceRaw: 110, tsUs: T0 + 500_000 }];
    const r = settleRound(base({ openLev: 10, entryRaw: 100, actions, exitRaw: 105 }));
    // banked = 1 + 10*(110/100-1) = ... open eq at flip = 1 + 10*(0.1) = 2 → banked becomes 1.0
    // after flip dir=-1, entry=110: eq = 1 + 1.0 + (-1)*10*(105/110 - 1) ≈ 2 + 0.4545 = 2.4545
    expect(r.equity).toBeGreaterThan(2.4);
    expect(r.equity).toBeLessThan(2.5);
    expect(r.outcome).toBe("cashout");
  });

  it("a mid-round leverage change re-anchors the position", () => {
    const actions: Action[] = [{ kind: "lever", lev: 20, priceRaw: 101, tsUs: T0 + 500_000 }];
    const r = settleRound(base({ openLev: 10, entryRaw: 100, actions, exitRaw: 102 }));
    // segment 1 banks 10*(101/100-1)=0.1 ; segment 2 at lev20 from 101→102: 20*(102/101-1)≈0.198
    // eq ≈ 1 + 0.1 + 0.198 = 1.298
    expect(r.equity).toBeCloseTo(1 + 0.1 + 20 * (102 / 101 - 1), 6);
  });

  it("liquidation is caught at an action mark, not only at exit", () => {
    // long lev 10 dips to 91 at the action mark (eq 0.1 ≤ LIQ) even though exit recovers to 100
    const actions: Action[] = [{ kind: "lever", lev: 50, priceRaw: 91, tsUs: T0 + 500_000 }];
    const r = settleRound(base({ openLev: 10, entryRaw: 100, actions, exitRaw: 100 }));
    expect(r.outcome).toBe("liq");
    expect(r.payoutCoins).toBe(0);
  });

  it("a bonus action adds to banked without re-anchoring (pickup)", () => {
    const actions: Action[] = [{ kind: "bonus", amount: 0.5, priceRaw: 100, tsUs: T0 + 500_000 }];
    const r = settleRound(base({ openLev: 10, entryRaw: 100, actions, exitRaw: 100 }));
    // bonus adds 0.5 to banked; exit at entry → eq = 1 + 0.5 = 1.5
    expect(r.equity).toBeCloseTo(1.5, 9);
    expect(r.payoutCoins).toBe(Math.floor(10 * 1.5 * 0.95)); // 14
  });

  it("evaluates the second action mark against the rebased position (multi-segment)", () => {
    // long → flip short at 110 (banks +1.0, re-anchors to 110); then at 130 the SHORT liquidates,
    // proving the 2nd mark is checked against the post-flip position, not the original long.
    const actions: Action[] = [
      { kind: "flip", dir: -1, priceRaw: 110, tsUs: T0 + 500_000 },
      { kind: "lever", lev: 10, priceRaw: 130, tsUs: T0 + 600_000 },
    ];
    const r = settleRound(base({ openLev: 10, entryRaw: 100, actions, exitRaw: 100 }));
    // at price 130 the short's eq = 1 + 1.0 + (-1)*10*(130/110 - 1) ≈ 0.18 ≤ LIQ → liq before the lever applies
    expect(r.outcome).toBe("liq");
    expect(r.payoutCoins).toBe(0);
  });
});
