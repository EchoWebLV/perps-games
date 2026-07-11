import { describe, it, expect } from "vitest";
import { RoundEngine } from "./round";

function launched(lev = 10) {
  const r = new RoundEngine();
  r.launch({ dir: 1, lev, stake: 1, entryRaw: 100, startMs: 0 });
  return r;
}

describe("RoundEngine", () => {
  it("starts idle", () => {
    expect(new RoundEngine().snapshot(100, 0).phase).toBe("idle");
  });

  it("launch → live; equity tracks price", () => {
    const r = launched();
    const s = r.tick(101, 1000);
    expect(s.phase).toBe("live");
    expect(s.equity).toBeCloseTo(1.1, 6);
  });

  it("liquidates when equity <= LIQ", () => {
    const r = launched(50);
    const s = r.tick(98, 1000); // equity → 0
    expect(s.phase).toBe("liquidated");
    expect(s.reason).toBe("liq");
    expect(s.payout).toBe(0);
  });

  it("caps at CAP and settles", () => {
    const r = launched(1000);
    const s = r.tick(105, 1000); // equity huge → cap
    expect(s.phase).toBe("settled");
    expect(s.reason).toBe("cap");
    expect(s.equity).toBe(25); // CONFIG.CAP
  });

  it("settles on time cap", () => {
    const r = launched();
    const s = r.tick(101, 60_000); // elapsed >= MAXSEC
    expect(s.phase).toBe("settled");
    expect(s.reason).toBe("time");
  });

  it("honors a per-round maxSec over CONFIG.MAXSEC (Six Wheeler Heavy Load)", () => {
    const r = new RoundEngine();
    r.launch({ dir: 1, lev: 10, stake: 1, entryRaw: 100, startMs: 0, maxSec: 90 });
    expect(r.tick(101, 60_000).phase).toBe("live"); // past the default 60s cap — still running
    const s = r.tick(101, 90_000);
    expect(s.phase).toBe("settled");
    expect(s.reason).toBe("time");
  });

  it("previews the Highway borrow fee without time-settling", () => {
    const r = new RoundEngine();
    r.launch({
      dir: 1, lev: 250, stake: 1, entryRaw: 100, startMs: 0,
      maxSec: Number.POSITIVE_INFINITY, borrowBpsPerDay: 1,
    });
    const s = r.tick(100, 86_400_000);
    expect(s.phase).toBe("live");
    expect(s.equity).toBeCloseTo(0.975, 8);
  });

  it("banks each fee interval once when Highway leverage changes", () => {
    const r = new RoundEngine();
    r.launch({
      dir: 1, lev: 250, stake: 1, entryRaw: 100, startMs: 0,
      maxSec: Number.POSITIVE_INFINITY, borrowBpsPerDay: 1,
    });
    r.setLeverage(100, 100, 43_200_000);
    const s = r.tick(100, 86_400_000);
    expect(s.equity).toBeCloseTo(1 - 0.0125 - 0.005, 8);
  });

  it("cashout settles with reason cashout", () => {
    const r = launched();
    r.tick(102, 1000);
    const s = r.cashout(102, 1500);
    expect(s.phase).toBe("settled");
    expect(s.reason).toBe("cashout");
    expect(s.payout).toBeCloseTo(1 * 1.2 * 0.95, 6); // equity 1.2, edge 0.05
  });

  it("setLeverage banks the current segment and re-anchors", () => {
    const r = launched(10);
    r.tick(110, 1000); // equity 2.0 at this point
    r.setLeverage(20, 110);
    const s = r.tick(110, 1100);
    // banked = 1.0; new segment 0 → equity 2.0; lev now 20
    expect(s.lev).toBe(20);
    expect(s.equity).toBeCloseTo(2, 6);
  });

  it("ignores ticks after settle", () => {
    const r = launched();
    r.cashout(102, 1500);
    const s = r.tick(200, 2000);
    expect(s.phase).toBe("settled");
  });
});
