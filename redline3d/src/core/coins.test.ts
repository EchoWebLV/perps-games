import { describe, expect, test } from "vitest";
import { addCoins, coinLabel, coinPulseClass } from "./coins";

describe("coins", () => {
  test("adds collected pickups to the current total", () => {
    expect(addCoins(7, 3)).toBe(10);
  });

  test("does not reduce the total when a frame reports no pickups", () => {
    expect(addCoins(7, 0)).toBe(7);
  });

  test("formats the coin counter label", () => {
    expect(coinLabel(12)).toBe("12");
  });

  test("returns a pulse class only when the coin total increases", () => {
    expect(coinPulseClass(3, 4)).toBe("coin-pop");
    expect(coinPulseClass(4, 4)).toBe("");
  });
});
