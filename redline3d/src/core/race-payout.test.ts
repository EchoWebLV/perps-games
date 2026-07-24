import { describe, expect, it } from "vitest";
import { RAKE, OWNER_POOL_SHARE, PODIUM_SPLIT, ownerPodiumPayout } from "./race-payout";

describe("ownerPodiumPayout", () => {
  it("keeps the locked economy constants", () => {
    expect(RAKE).toBe(0.05);
    expect(OWNER_POOL_SHARE).toBe(0.4);
    expect(PODIUM_SPLIT).toEqual([0.5, 0.3, 0.2]);
  });
  it("pays the podium from the rake slice, to the cent", () => {
    // pool $250 → rake $12.50 → owner pool $5.00 → 2.50 / 1.50 / 1.00
    expect(ownerPodiumPayout(250, 0)).toBe(2.5);
    expect(ownerPodiumPayout(250, 1)).toBe(1.5);
    expect(ownerPodiumPayout(250, 2)).toBe(1.0);
  });
  it("pays zero off the podium and on an empty pool", () => {
    expect(ownerPodiumPayout(250, 3)).toBe(0);
    expect(ownerPodiumPayout(250, 7)).toBe(0);
    expect(ownerPodiumPayout(0, 0)).toBe(0);
  });
  it("rounds to cents (banker-free, plain round)", () => {
    // pool $33.33 → rake 1.6665 → owner pool 0.6666 → 1st 0.3333 → $0.33
    expect(ownerPodiumPayout(33.33, 0)).toBe(0.33);
  });
});
