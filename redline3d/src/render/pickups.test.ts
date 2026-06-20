import { describe, expect, test } from "vitest";
import { coinMult } from "./pickups";

describe("coinMult tiers (Vaporwave rainbow coins)", () => {
  test("maps r-ranges to the right multipliers", () => {
    expect(coinMult(0)).toBe(5);
    expect(coinMult(0.029)).toBe(5);
    expect(coinMult(0.03)).toBe(3);
    expect(coinMult(0.089)).toBe(3);
    expect(coinMult(0.09)).toBe(2);
    expect(coinMult(0.209)).toBe(2);
    expect(coinMult(0.21)).toBe(1);
    expect(coinMult(0.999)).toBe(1);
  });

  test("distribution is ~3% / 6% / 12% / 79% over a uniform sweep", () => {
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 5: 0 };
    const M = 100000;
    for (let i = 0; i < M; i++) counts[coinMult(i / M)]++;
    expect(counts[5] / M).toBeCloseTo(0.03, 3);
    expect(counts[3] / M).toBeCloseTo(0.06, 3);
    expect(counts[2] / M).toBeCloseTo(0.12, 3);
    expect(counts[1] / M).toBeCloseTo(0.79, 3);
  });
});
