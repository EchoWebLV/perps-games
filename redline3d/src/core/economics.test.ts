import { describe, it, expect } from "vitest";
import { CONFIG } from "./config";
import { equityOf, payoutOf, profitOf, liqPriceOf, bufferOf, rebank } from "./economics";
import type { Position } from "./types";

const base: Position = { dir: 1, lev: 10, entryRaw: 100, banked: 0 };

describe("economics", () => {
  it("equity is linear from entry: 1 + banked + dir*lev*(price/entry - 1)", () => {
    expect(equityOf(base, 100)).toBeCloseTo(1, 6);
    expect(equityOf(base, 101)).toBeCloseTo(1.1, 6); // 10 * 0.01 = 0.1
    expect(equityOf({ ...base, dir: -1 }, 99)).toBeCloseTo(1.1, 6);
  });

  it("equity is clamped at 0", () => {
    expect(equityOf({ ...base, lev: 50 }, 98)).toBe(0); // 50*(-0.02) = -1 → clamp
  });

  it("equity includes banked gains", () => {
    expect(equityOf({ ...base, banked: 1 }, 101)).toBeCloseTo(2.1, 6);
  });

  it("payout applies the house edge", () => {
    expect(payoutOf(1, 1.1, CONFIG.EDGE)).toBeCloseTo(1.045, 6); // 1 * 1.1 * 0.95
    expect(payoutOf(2, 1.0, CONFIG.EDGE)).toBeCloseTo(1.9, 6);
  });

  it("payout floors equity at 0", () => {
    expect(payoutOf(1, -3, CONFIG.EDGE)).toBe(0);
  });

  it("profit = payout - stake", () => {
    expect(profitOf(1, 1.045)).toBeCloseTo(0.045, 6);
  });

  it("liqPrice is where a long/short hits the LIQ threshold", () => {
    // dir 1, lev 50, entry 100, LIQ 0.2 → 100*(1 - 0.8/50) = 98.4
    expect(liqPriceOf(100, 1, 50, CONFIG.LIQ)).toBeCloseTo(98.4, 6);
    expect(liqPriceOf(100, -1, 50, CONFIG.LIQ)).toBeCloseTo(101.6, 6);
  });

  it("buffer is 1 at/above entry, 0 at LIQ", () => {
    expect(bufferOf(1.5, CONFIG.LIQ)).toBe(1);
    expect(bufferOf(0.6, CONFIG.LIQ)).toBeCloseTo(0.5, 6); // (0.6-0.2)/0.8
    expect(bufferOf(0.2, CONFIG.LIQ)).toBe(0);
    expect(bufferOf(0.1, CONFIG.LIQ)).toBe(0);
  });

  it("rebank realizes the current segment and re-anchors entry", () => {
    const r = rebank({ ...base }, 110); // 10*(110/100-1) = 1.0
    expect(r.banked).toBeCloseTo(1, 6);
    expect(r.entryRaw).toBe(110);
    // after rebank, equity continues from the new anchor
    expect(equityOf(r, 110)).toBeCloseTo(2, 6); // 1 + 1 + 0
  });
});
