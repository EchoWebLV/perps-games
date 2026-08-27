import { describe, expect, test } from "vitest";
import { rollCrate, crateByKey, type CrateCar } from "./crate";
import {
  PITY, applyPityWeights, emptyPity, hardPityDue, hitTopTier, loadPity, nextPity,
  normalizePity, rollCrateWithPity, savePity,
} from "./pity";

const ROSTER: CrateCar[] = [
  { name: "c1", rarity: 1 }, { name: "c2", rarity: 1 },
  { name: "u1", rarity: 2 },
  { name: "r1", rarity: 3 },
  { name: "e1", rarity: 4 },
  { name: "l1", rarity: 5 },
];
const W = {
  wooden: crateByKey("wooden").tierWeights,
  silver: crateByKey("silver").tierWeights,
  gold: crateByKey("gold").tierWeights,
};

describe("pity rules", () => {
  test("wooden pities toward Rare, never Legendary", () => {
    expect(PITY.wooden.topTier).toBe(3);
    expect(PITY.silver.topTier).toBe(5);
    expect(PITY.gold.topTier).toBe(5);
  });

  test("soft pity does not change weights before the soft threshold", () => {
    expect(applyPityWeights(W.silver, "silver", 10)).toEqual(W.silver);
  });

  test("soft pity adds bump to the top tier after SOFT misses", () => {
    // misses=11 → this open is the 12th → extra = 12-12+1 wait: extra = max(0, misses+1-soft)
    // misses=11, soft=12 → extra = 0. misses=12 → extra = 1 → +4 legendary
    expect(applyPityWeights(W.silver, "silver", 12)[5]).toBe((W.silver[5] ?? 0) + 4);
  });

  test("hard pity is due on the HARD-th miss inclusive", () => {
    expect(hardPityDue("gold", 6)).toBe(false); // 7th open
    expect(hardPityDue("gold", 7)).toBe(true);  // 8th open
  });

  test("nextPity resets on a top-tier hit", () => {
    expect(nextPity("gold", 3, true)).toBe(0);
    expect(nextPity("gold", 3, false)).toBe(4);
  });
});

describe("rollCrateWithPity", () => {
  test("hard pity forces wooden Rare even when the raw draw is Common", () => {
    const raw = rollCrate(ROSTER, W.wooden, 0, 0)!;
    expect(raw.rarity).toBe(1);
    const pitied = rollCrateWithPity(ROSTER, "wooden", W.wooden, 11, 0, 0)!;
    expect(pitied.rarity).toBe(3);
    expect(hitTopTier(pitied, "wooden")).toBe(true);
  });

  test("hard pity forces silver/gold Legendary", () => {
    expect(rollCrateWithPity(ROSTER, "silver", W.silver, 19, 0, 0)!.rarity).toBe(5);
    expect(rollCrateWithPity(ROSTER, "gold", W.gold, 7, 0, 0)!.rarity).toBe(5);
  });

  test("without pity a low draw is unchanged", () => {
    expect(rollCrateWithPity(ROSTER, "wooden", W.wooden, 0, 0, 0)!.name)
      .toBe(rollCrate(ROSTER, W.wooden, 0, 0)!.name);
  });
});

describe("pity persistence", () => {
  test("normalizePity clamps junk", () => {
    expect(normalizePity({ wooden: -3, silver: 2.8, gold: "x" })).toEqual({ wooden: 0, silver: 2, gold: 0 });
    expect(normalizePity(null)).toEqual(emptyPity());
  });

  test("load/save round-trips", () => {
    const mem: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => { mem[k] = v; },
    };
    savePity({ wooden: 4, silver: 0, gold: 2 }, storage);
    expect(loadPity(storage)).toEqual({ wooden: 4, silver: 0, gold: 2 });
  });
});
