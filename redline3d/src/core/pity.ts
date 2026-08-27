// Pity for crate opens — deterministic, no I/O. One counter per crate key. Soft pity
// adds weight to that crate's top droppable tier; hard pity forces it. Wooden never
// invents a Legendary (its top tier is Rare).

import { rollCrate, type CrateCar } from "./crate";
import { tierOf, type Rarity } from "./rarity";

export type CrateKey = "wooden" | "silver" | "gold";

export interface PityRule {
  topTier: Rarity;
  soft: number;
  hard: number;
  bump: number;
}

export const PITY: Record<CrateKey, PityRule> = {
  wooden: { topTier: 3, soft: 8, hard: 12, bump: 8 },
  silver: { topTier: 5, soft: 12, hard: 20, bump: 4 },
  gold: { topTier: 5, soft: 4, hard: 8, bump: 10 },
};

export type PityState = Record<CrateKey, number>;

export const emptyPity = (): PityState => ({ wooden: 0, silver: 0, gold: 0 });

export function normalizePity(raw: unknown): PityState {
  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  return { wooden: n(src.wooden), silver: n(src.silver), gold: n(src.gold) };
}

/** After SOFT misses, add `bump` to the top-tier weight for every extra miss (inclusive of the current open). */
export function applyPityWeights(
  weights: Partial<Record<Rarity, number>>,
  key: CrateKey,
  misses: number,
): Partial<Record<Rarity, number>> {
  const rule = PITY[key];
  const extra = Math.max(0, misses + 1 - rule.soft);
  if (extra <= 0) return { ...weights };
  const next = { ...weights };
  next[rule.topTier] = (next[rule.topTier] ?? 0) + extra * rule.bump;
  return next;
}

export function hardPityDue(key: CrateKey, misses: number): boolean {
  return misses + 1 >= PITY[key].hard;
}

/** misses after this open. Hit the crate's top tier → reset to 0. */
export function nextPity(key: CrateKey, misses: number, hitTop: boolean): number {
  return hitTop ? 0 : misses + 1;
}

export function rollCrateWithPity<T extends CrateCar>(
  cars: T[],
  key: CrateKey,
  weights: Partial<Record<Rarity, number>>,
  misses: number,
  rTier: number,
  rCar: number,
): T | null {
  const rule = PITY[key];
  const used = hardPityDue(key, misses)
    ? { [rule.topTier]: 100 } as Partial<Record<Rarity, number>>
    : applyPityWeights(weights, key, misses);
  return rollCrate(cars, used, rTier, rCar);
}

export function hitTopTier(car: CrateCar | null, key: CrateKey): boolean {
  if (!car) return false;
  return tierOf(car.rarity).id === PITY[key].topTier;
}

export const PITY_STORAGE_KEY = "redline.pity.v1";

export function loadPity(storage: Pick<Storage, "getItem"> = localStorage): PityState {
  try { return normalizePity(JSON.parse(storage.getItem(PITY_STORAGE_KEY) ?? "null")); }
  catch { return emptyPity(); }
}

export function savePity(state: PityState, storage: Pick<Storage, "setItem"> = localStorage): void {
  try { storage.setItem(PITY_STORAGE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}
