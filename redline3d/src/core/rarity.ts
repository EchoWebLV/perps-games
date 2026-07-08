// Collectible rarity tiers + crate drop odds — the SINGLE source of truth for both the
// garage display AND the (future) crate opener, so "crates know what chance there is to get."
//
// rarity = prestige / looks ONLY, never a perp edge (abilities stay EV-neutral).
// `weight` is the per-open % for a fair crate; all poolable tiers sum to 100.
// Curve set by the user 2026-07-06: Common 50 / Uncommon 28 / Rare 14 / Epic 6 / Legendary 2.

export type Rarity = 1 | 2 | 3 | 4 | 5;

export interface Tier {
  id: Rarity;
  key: string;    // machine id
  name: string;   // uppercase display label
  color: string;  // gem / accent color — gray → green → blue → purple → gold
  weight: number; // crate drop chance in %, poolable tiers sum to 100
}

export const TIERS: readonly Tier[] = [
  { id: 1, key: "common",    name: "COMMON",    color: "#9aa4b2", weight: 50 },
  { id: 2, key: "uncommon",  name: "UNCOMMON",  color: "#41d67f", weight: 28 },
  { id: 3, key: "rare",      name: "RARE",      color: "#3ba7ff", weight: 14 },
  { id: 4, key: "epic",      name: "EPIC",      color: "#b06bff", weight: 6  },
  { id: 5, key: "legendary", name: "LEGENDARY", color: "#ffd166", weight: 2  },
];

/** clamp any incoming rarity to a real tier (defaults to Common) */
export const tierOf = (r: number | undefined): Tier => TIERS[Math.max(1, Math.min(5, (r ?? 1) | 0)) - 1];

/** can this car drop from a crate? Release/pool state ONLY — NOT ownership. You pull cars you
 *  don't own yet, so `locked` (= not owned, a garage-UI flag) must NOT exclude here. */
export interface PoolLike { rarity?: number; pool?: boolean; comingSoon?: boolean; locked?: boolean }
export const poolable = (c: PoolLike): boolean => c.pool !== false && !c.comingSoon;

// Per-tier crate odds against the LIVE roster: the tier weight, the cars that can actually
// drop, and each surviving car's individual pull chance. The opener rolls a tier by `weight`,
// then picks uniformly within the tier — so perCar = weight / (cars in that tier's pool).
export function crateOdds<T extends PoolLike>(cars: T[]) {
  return TIERS.map((tier) => {
    const inTier = cars.filter((c) => (c.rarity ?? 1) === tier.id && poolable(c));
    return { tier, cars: inTier, perCar: inTier.length ? tier.weight / inTier.length : 0 };
  });
}

/** this one car's crate pull chance (0 if it isn't in the pool), given the whole roster */
export function pullChance<T extends PoolLike>(car: T, cars: T[]): number {
  if (!poolable(car)) return 0;
  const t = tierOf(car.rarity);
  const n = cars.filter((c) => (c.rarity ?? 1) === t.id && poolable(c)).length;
  return n ? t.weight / n : 0;
}
