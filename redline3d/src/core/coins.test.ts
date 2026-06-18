import { describe, expect, test } from "vitest";
import { addCoins, coinLabel } from "./coins";

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
});
