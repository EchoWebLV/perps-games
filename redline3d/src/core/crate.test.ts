import { describe, expect, test } from "vitest";
import { rollCrate, dupeScrap, DUPE_SCRAP, pickLevel, CRATES, crateByKey, type CrateCar } from "./crate";

// a synthetic roster with cars in every tier so pulls are deterministic
const ROSTER: CrateCar[] = [
  { name: "c1", rarity: 1 }, { name: "c2", rarity: 1 },
  { name: "u1", rarity: 2 },
  { name: "r1", rarity: 3 },
  { name: "e1", rarity: 4 },
  { name: "l1", rarity: 5 },
];
const W = { wooden: crateByKey("wooden").tierWeights, silver: crateByKey("silver").tierWeights, gold: crateByKey("gold").tierWeights };

describe("rollCrate — tier by the crate's weights, car uniform within tier", () => {
  test("wooden (50/30/20, C·U·R only) never drops Epic or Legendary", () => {
    expect(rollCrate(ROSTER, W.wooden, 0, 0)!.name).toBe("c1");    // rTier 0 → Common
    expect(rollCrate(ROSTER, W.wooden, 0.99, 0)!.rarity).toBe(3);  // top of wooden → Rare
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(rollCrate(ROSTER, W.wooden, i / 5000, 0.5)!.rarity!);
    expect([...seen].sort()).toEqual([1, 2, 3]);                   // only C/U/R ever
  });

  test("silver (40/30/16/10/4) puts Legendary in the top 4%", () => {
    expect(rollCrate(ROSTER, W.silver, 0.95, 0)!.rarity).toBe(4);  // 0.95 → still Epic
    expect(rollCrate(ROSTER, W.silver, 0.97, 0)!.rarity).toBe(5);  // 0.96..1.0 → Legendary (4%)
    const n: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const M = 100000; for (let i = 0; i < M; i++) n[rollCrate(ROSTER, W.silver, i / M, 0.5)!.rarity!]++;
    expect(n[5] / M).toBeCloseTo(0.04, 2);                          // Legendary ≈ 4%
    expect(n[3] / M).toBeCloseTo(0.16, 2);                          // Rare shaved to 16%
  });

  test("gold (40/35/25, R·E·L only) never drops Common or Uncommon", () => {
    expect(rollCrate(ROSTER, W.gold, 0, 0)!.rarity).toBe(3);       // first weighted tier → Rare
    expect(rollCrate(ROSTER, W.gold, 0.99, 0)!.rarity).toBe(5);    // top → Legendary
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(rollCrate(ROSTER, W.gold, i / 5000, 0.5)!.rarity!);
    expect([...seen].sort()).toEqual([3, 4, 5]);                   // only R/E/L ever
  });

  test("skips a weighted tier that has no poolable car (renormalizes)", () => {
    const noRare: CrateCar[] = [{ name: "c", rarity: 1 }, { name: "e", rarity: 4 }]; // gold weights R/E/L, only Epic present
    expect(rollCrate(noRare, W.gold, 0.0, 0)!.name).toBe("e");
    expect(rollCrate([{ name: "x", rarity: 1, pool: false }], W.wooden, 0, 0)).toBeNull();
    expect(rollCrate([], W.silver, 0.5, 0.5)).toBeNull();
  });
});

describe("CRATES config", () => {
  test("prices, scrap, and tier coverage match the spec", () => {
    const [w, s, g] = CRATES;
    expect([w.priceCoins, s.priceCoins, g.priceCoins]).toEqual([250, 1000, 3000]);
    expect([w.scrap, s.scrap, g.scrap]).toEqual([25, 300, 800]);
    expect([w.levelChance, s.levelChance, g.levelChance]).toEqual([0.05, 0.25, 0.75]);
    expect([w.priceSol, s.priceSol, g.priceSol]).toEqual([undefined, 0.1, 0.2]);
    expect(Object.values(w.tierWeights).reduce((a, b) => a + b, 0)).toBe(100);
    expect(Object.values(s.tierWeights).reduce((a, b) => a + b, 0)).toBe(100);
    expect(Object.values(g.tierWeights).reduce((a, b) => a + b, 0)).toBe(100);
    expect(g.tierWeights[1]).toBeUndefined();                      // gold: no Common
    expect(w.tierWeights[5]).toBeUndefined();                      // wooden: no Legendary
  });
});

describe("dupeScrap — duplicate bonus scales with rarity", () => {
  test("maps each tier to its scrap payout, clamped", () => {
    expect([1, 2, 3, 4, 5].map(dupeScrap)).toEqual([3, 6, 12, 25, 50]);
    expect(dupeScrap(undefined)).toBe(DUPE_SCRAP[1]);
    expect(dupeScrap(99)).toBe(DUPE_SCRAP[5]);
  });
});

describe("pickLevel — additive level-skin roll", () => {
  const locked = ["neon-city", "desert", "ice"];
  test("misses when the roll is at/above the chance", () => {
    expect(pickLevel(locked, 0.25, 0.25, 0)).toBeNull(); // rChance == chance → miss
    expect(pickLevel(locked, 0.25, 0.9, 0)).toBeNull();
  });
  test("hits and picks a locked level when the roll is under the chance", () => {
    expect(pickLevel(locked, 0.75, 0.1, 0)).toBe("neon-city");
    expect(pickLevel(locked, 0.75, 0.1, 0.5)).toBe("desert");   // middle
    expect(pickLevel(locked, 0.75, 0.1, 0.99)).toBe("ice");     // last
  });
  test("null when nothing is left to unlock", () => {
    expect(pickLevel([], 1, 0, 0)).toBeNull();
  });
});
