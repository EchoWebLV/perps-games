import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  rollCrate, dupeScrap, DUPE_SCRAP, pickLevel, CRATES, crateByKey,
  drawsFromSeed, verifyCrateOpen, type CrateCar,
} from "./crate";

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

// ── commit-reveal proof: the client re-derives everything the server claims ──
const SEED = "07".repeat(32);
const NONCE = "5a".repeat(16);
const commitmentOf = (seedHex: string, nonceHex: string) =>
  createHash("sha256").update(Buffer.from(seedHex, "hex")).update(Buffer.from(nonceHex, "hex")).digest("hex");

describe("drawsFromSeed — mirrors the server's published derivation", () => {
  test("draw[i] = sha256(seed‖[i]) top 32 bits / 2^32", () => {
    const draws = drawsFromSeed(SEED, 4);
    expect(draws).toHaveLength(4);
    draws.forEach((d) => { expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThan(1); });
    const h = createHash("sha256").update(Buffer.from(SEED, "hex")).update(Buffer.from([0])).digest();
    expect(draws[0]).toBeCloseTo(h.readUInt32BE(0) / 2 ** 32, 12);
    expect(drawsFromSeed(SEED, 4)).toEqual(draws); // deterministic
  });

  test("a 0x prefix and upper case parse identically", () => {
    expect(drawsFromSeed(`0x${SEED.toUpperCase()}`, 2)).toEqual(drawsFromSeed(SEED, 2));
  });

  test("refuses a malformed seed rather than inventing draws", () => {
    expect(() => drawsFromSeed("nothex", 2)).toThrow();
    expect(() => drawsFromSeed("abc", 2)).toThrow(); // odd length
  });
});

describe("verifyCrateOpen — never silently accept an unproven roll", () => {
  const commitment = commitmentOf(SEED, NONCE);
  const reveal = { seedHex: SEED, nonceHex: NONCE, commitment };
  const draws = drawsFromSeed(SEED, 4);

  test("accepts a reveal that hashes to the pre-published commitment and derives the draws", () => {
    expect(verifyCrateOpen({ commitment, reveal, draws })).toEqual({ ok: true, checkedDraws: true });
  });

  test("rejects a seed that does not hash to the commitment", () => {
    const forged = { ...reveal, seedHex: "08".repeat(32) };
    expect(verifyCrateOpen({ commitment, reveal: forged, draws })).toEqual({ ok: false, reason: "commitment_mismatch" });
  });

  test("rejects a swapped nonce", () => {
    expect(verifyCrateOpen({ commitment, reveal: { ...reveal, nonceHex: "5b".repeat(16) }, draws }))
      .toEqual({ ok: false, reason: "commitment_mismatch" });
  });

  test("rejects draws that the revealed seed does not produce", () => {
    expect(verifyCrateOpen({ commitment, reveal, draws: [0.5, 0.5, 0.5, 0.5] }))
      .toEqual({ ok: false, reason: "draws_mismatch" });
  });

  test("rejects a response that reveals nothing at all", () => {
    expect(verifyCrateOpen({ commitment, reveal: null, draws })).toEqual({ ok: false, reason: "missing_reveal" });
    expect(verifyCrateOpen({ commitment, reveal: undefined, draws: undefined })).toEqual({ ok: false, reason: "missing_reveal" });
  });

  test("rejects a reveal whose echoed commitment disagrees with the one we were handed", () => {
    expect(verifyCrateOpen({ commitment, reveal: { ...reveal, commitment: "ff".repeat(32) }, draws }))
      .toEqual({ ok: false, reason: "commitment_mismatch" });
  });

  test("verifies the commitment alone when the response echoes no draws, and says so", () => {
    expect(verifyCrateOpen({ commitment, reveal })).toEqual({ ok: true, checkedDraws: false });
  });

  test("a malformed reveal fails closed instead of throwing", () => {
    expect(verifyCrateOpen({ commitment, reveal: { seedHex: "zz", nonceHex: NONCE, commitment }, draws }))
      .toEqual({ ok: false, reason: "commitment_mismatch" });
  });
});
