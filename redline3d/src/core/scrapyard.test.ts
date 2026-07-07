import { describe, test, expect } from "vitest";
import { meltValue, meltAllValue } from "./scrapyard";

describe("melt valuation", () => {
  test("melt value follows the rarity scale {3,6,12,25,50}", () => {
    expect(meltValue(1)).toBe(3);
    expect(meltValue(3)).toBe(12);
    expect(meltValue(5)).toBe(50);
    expect(meltValue(undefined)).toBe(3); // defaults to Common
  });

  test("meltAllValue sums value x spares", () => {
    expect(meltAllValue([
      { rarity: 1, spares: 3 }, // 3 x 3 = 9
      { rarity: 5, spares: 1 }, // 50 x 1 = 50
      { rarity: 3, spares: 0 }, // 0
    ])).toBe(59);
  });
});
