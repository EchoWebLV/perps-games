// Pure grid assembly for a race: the player's equipped car (or none, for spectate)
// plus house cars drawn from the roster. The stats mapping table the spec promises
// lives here: rarity → base strength (moved from race-preview), ability → surge amp bonus.
import type { CarOption, CarAbility } from "../ui/carpicker";
import type { Rarity } from "./rarity";

export const GRID_SIZE = 8;

/** rarity → outcome-scoring strength (source of truth; race-preview re-imports this). */
export const STRENGTH: Record<Rarity, number> = { 1: 1.0, 2: 1.35, 3: 1.8, 4: 2.4, 5: 3.2 };

/** Perk flavor on the sim: a small extra surge amplitude for aggressive abilities. */
const SURGE_AMP_BONUS: Partial<Record<CarAbility, number>> = {
  nitro: 0.06, pinkRod: 0.05, slots: 0.04, flux: 0.03, swerve: 0.03,
};
export function surgeAmpBonus(ability: CarAbility | undefined): number {
  return (ability && SURGE_AMP_BONUS[ability]) || 0;
}

export interface GridEntrant {
  name: string; url: string; scale?: number; yaw?: number;
  rarity: Rarity; strength: number; surgeAmpBonus: number; isPlayer: boolean;
}

// Intentionally duplicates `poolable` from ./rarity: crate-droppable and race-eligible are
// distinct axes that merely coincide today — keep them separate so they can diverge later.
const raceable = (c: CarOption): boolean => c.pool !== false && !c.comingSoon;

function toEntrant(c: CarOption, isPlayer: boolean): GridEntrant {
  const rarity = (c.rarity ?? 1) as Rarity;
  return {
    name: c.name, url: c.url, scale: c.scale, yaw: c.yaw,
    rarity, strength: STRENGTH[rarity], surgeAmpBonus: surgeAmpBonus(c.ability), isPlayer,
  };
}

/** Player car (by name, or null to spectate) + house fill, no duplicates, up to GRID_SIZE. */
export function buildGrid(roster: CarOption[], playerCarName: string | null, rng: () => number): GridEntrant[] {
  const grid: GridEntrant[] = [];
  // Player car is exempt from the `raceable` filter — you race whatever you equipped. An
  // unknown playerCarName (or null) finds no player, so the grid is all-house.
  const player = playerCarName ? roster.find((c) => c.name === playerCarName) : undefined;
  if (player) grid.push(toEntrant(player, true));
  const pool = roster.filter((c) => raceable(c) && c.name !== player?.name);
  // Fisher–Yates on a copy, driven by the caller's rng so outcomes stay seedable.
  const bag = [...pool];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  for (const c of bag) {
    if (grid.length >= GRID_SIZE) break;
    grid.push(toEntrant(c, false));
  }
  return grid;
}
