import { describe, expect, test } from "vitest";
import { upgradeCost, trackValue, MAX_LEVEL } from "./upgrades";

describe("upgrade tree math", () => {
  test("cost escalates per level", () => {
    expect(upgradeCost(0)).toBe(20);
    expect(upgradeCost(1)).toBe(40);
    expect(upgradeCost(9)).toBe(200); // level 9 → 10 (the last)
  });

  test("Turbo: +50× leverage per level", () => {
    expect(trackValue(1000, 50, 0)).toBe(1000);
    expect(trackValue(1000, 50, 1)).toBe(1050);
    expect(trackValue(1000, 50, MAX_LEVEL)).toBe(1500);
  });

  test("Tank: +6s round time per level", () => {
    expect(trackValue(60, 6, 0)).toBe(60);
    expect(trackValue(60, 6, MAX_LEVEL)).toBe(120);
  });

  test("Suspension: -1pp liquidation floor per level", () => {
    expect(trackValue(0.2, -0.01, 0)).toBeCloseTo(0.2, 6);
    expect(trackValue(0.2, -0.01, MAX_LEVEL)).toBeCloseTo(0.1, 6);
  });
});
