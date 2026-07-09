// The crate opener's core: three crate tiers, each with its own price, scrap payout, and car-rarity
// odds; plus a duplicate's Scrap value. Pure + deterministic (takes the random draws as args) so it's
// fully testable; the live opener feeds draws from a RandomnessProvider — client RNG now, MagicBlock
// VRF behind the same port later.

import { TIERS, tierOf, poolable, type Rarity } from "./rarity";

/** a source of uniform draws in [0,1). client RNG now; VRF (async) swaps in behind this later. */
export interface RandomnessProvider { next(): number; }
export const clientRandom: RandomnessProvider = { next: () => Math.random() };

export interface CrateCar {
  rarity?: number; name: string; pool?: boolean; comingSoon?: boolean; locked?: boolean;
  // model descriptor (present on the CAR_DEFS objects the roll returns) — used by the reveal viewer
  url?: string; scale?: number; yaw?: number;
}

// A crate tier. `tierWeights` is the per-crate car-rarity distribution — a tier absent from the map
// can't drop from that crate. `priceUsd` is the real-money option (deferred behind the payment rail).
export interface CrateType {
  key: "wooden" | "silver" | "gold";
  name: string;
  color: string;                          // UI accent (crate identity)
  priceCoins: number;
  priceUsd?: number;
  scrap: number;                          // guaranteed scrap per open
  levelChance: number;                    // chance (0..1) to also unlock a random locked level skin
  tierWeights: Partial<Record<Rarity, number>>;
}
export const CRATES: readonly CrateType[] = [
  { key: "wooden", name: "Wooden Crate", color: "#b07a45", priceCoins: 250,  priceUsd: 0.99, scrap: 25,   levelChance: 0.05, tierWeights: { 1: 50, 2: 30, 3: 20 } },
  { key: "silver", name: "Silver Crate", color: "#c3ccd8", priceCoins: 1000, priceUsd: 4.99, scrap: 300,  levelChance: 0.25, tierWeights: { 1: 40, 2: 30, 3: 16, 4: 10, 5: 4 } },
  { key: "gold",   name: "Gold Crate",   color: "#ffcf5a", priceCoins: 3000, priceUsd: 9.99, scrap: 800, levelChance: 0.75, tierWeights: { 3: 40, 4: 35, 5: 25 } },
];
export const crateByKey = (key: string): CrateType => CRATES.find((c) => c.key === key) ?? CRATES[0];

/** Roll a tier by the crate's weights (tiers absent/zero are skipped), then a car uniformly within
 *  that tier's poolable pool. Deterministic in (rTier, rCar) ∈ [0,1)². Returns null only if no
 *  weighted tier has a poolable car. */
export function rollCrate<T extends CrateCar>(cars: T[], weights: Partial<Record<Rarity, number>>, rTier: number, rCar: number): T | null {
  const avail = TIERS
    .filter((t) => (weights[t.id] ?? 0) > 0)
    .map((t) => ({ w: weights[t.id]!, pool: cars.filter((c) => (c.rarity ?? 1) === t.id && poolable(c)) }))
    .filter((x) => x.pool.length > 0);
  if (avail.length === 0) return null;
  const total = avail.reduce((s, x) => s + x.w, 0);
  let x = rTier * total;
  let chosen = avail[avail.length - 1];
  for (const a of avail) { if ((x -= a.w) < 0) { chosen = a; break; } }
  return chosen.pool[Math.min(chosen.pool.length - 1, Math.floor(rCar * chosen.pool.length))];
}

/** Scrap for a DUPLICATE car, added on top of the crate's base scrap (a rarer dupe is worth more). */
export const DUPE_SCRAP: Readonly<Record<number, number>> = { 1: 3, 2: 6, 3: 12, 4: 25, 5: 50 };
export const dupeScrap = (rarity?: number): number => DUPE_SCRAP[tierOf(rarity).id];

/** The crate's level roll (additive, on top of the car): with probability `chance`, unlock one
 *  random still-locked level skin. Returns the level key, or null (missed the roll, or all owned).
 *  Deterministic in (rChance, rPick) ∈ [0,1)². */
export function pickLevel(lockedKeys: string[], chance: number, rChance: number, rPick: number): string | null {
  if (lockedKeys.length === 0 || rChance >= chance) return null;
  return lockedKeys[Math.min(lockedKeys.length - 1, Math.floor(rPick * lockedKeys.length))];
}
