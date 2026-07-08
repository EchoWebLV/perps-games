// @vitest-environment node
import { describe, expect, test } from "vitest";
import { poolable, pullChance, crateOdds, tierOf, type PoolLike } from "./rarity";

// Benching a car (the RV / "Cook Wagon" — user verdict 2026-07-08, "not fun at all to drive") sets
// BOTH pool:false and comingSoon:true on its CAR_DEFS entry (main.ts), the same pair the Skull card
// ships with. This pins what those two flags must guarantee: the car is dropped from the crate pool
// entirely, and its tier-mates' per-car odds renormalize over the smaller pool. Not-pickable is
// enforced by comingSoon in the garage — covered by carpicker.test.ts's coming-soon tape tests.
describe("benched car (RV bench flags) — out of the crate pool, tier renormalizes", () => {
  const benched: PoolLike = { rarity: 1, pool: false, comingSoon: true }; // the RV's benched flags
  const commonA: PoolLike = { rarity: 1 };
  const commonB: PoolLike = { rarity: 1 };
  const roster = [benched, commonA, commonB];

  test("a benched car is not poolable and has 0 crate pull chance", () => {
    expect(poolable(benched)).toBe(false);
    expect(pullChance(benched, roster)).toBe(0);
  });

  test("crateOdds excludes it and lifts the surviving tier-mates' per-car share", () => {
    const commonWeight = tierOf(1).weight; // 50 on the user's curve
    const common = crateOdds(roster).find((r) => r.tier.id === 1)!;
    expect(common.cars).toHaveLength(2); // benched RV excluded, 2 survivors
    expect(common.cars).not.toContain(benched);
    expect(common.perCar).toBeCloseTo(commonWeight / 2, 6); // splits over 2, not 3
    // each survivor's own pull chance matches the renormalized share
    expect(pullChance(commonA, roster)).toBeCloseTo(commonWeight / 2, 6);
  });
});
