import { describe, expect, test } from "vitest";
import { bytesToDraws, crateByKey, hexToBytes, rollCrate, rollCrateWithPity } from "./crate-math.js";

const ROSTER = [
  { name: "c1", rarity: 1 }, { name: "u1", rarity: 2 }, { name: "r1", rarity: 3 },
  { name: "e1", rarity: 4 }, { name: "l1", rarity: 5 },
];

describe("crate-math locked vectors (match client)", () => {
  test("wooden never drops legendary; hard pity forces rare", () => {
    const w = crateByKey("wooden").tierWeights;
    expect(rollCrate(ROSTER, w, 0, 0)!.rarity).toBe(1);
    expect(rollCrateWithPity(ROSTER, "wooden", w, 11, 0, 0)!.rarity).toBe(3);
  });

  test("zero bytes derive four 0 draws", () => {
    const draws = bytesToDraws(hexToBytes("0".repeat(64)), 4);
    expect(draws).toEqual([0, 0, 0, 0]);
  });
});
