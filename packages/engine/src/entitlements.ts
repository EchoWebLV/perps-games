import { BASE_CONFIG } from "./config";
import type { CarAbility } from "./types";

/** On-chain global clamps (mirror onchain/raider settle.rs + state.rs). The envelope is a
 *  per-player TIGHTENING inside these — it must never widen them. Kept here so the parity test
 *  can assert the two never diverge. */
export const ONCHAIN = {
  RMIN: 10, RMAX: 3000,
  MIN_DUR: 5, MAX_DUR: 180,
  MIN_LIQ_FP: 100_000, MAX_LIQ_FP: 200_000,
  MAX_REFUND_FP: 200_000,
} as const;

export const MAX_UPGRADE_LEVEL = 10;
/** per-level deltas (from redline3d upgrades.ts TRACKS) — the single source of truth now. */
export const UPGRADE_STEP = { turbo: 50, tank: 6, suspension: -0.01 } as const;
/** Six Wheeler "Heavy Load" (main.ts HEAVY_*), default stake cap (controls.ts DEFAULT_PLAY_CAP),
 *  Nitro multiplier (nitro.ts), Skull grace, Bedrock airbag refund. */
export const HEAVY = { playCap: 25, durMult: 1.5, levMult: 0.5 } as const;
export const DEFAULT_STAKE_UNITS = 10;
export const NITRO_MULT = 2;
export const SKULL_GRACE_SECS = 2;
export const AIRBAG_REFUND_FP = 200_000;

/** coins to go from `level` → `level+1` (escalating). Mirrors redline3d upgrades.ts. */
export const upgradeCost = (level: number): number => 20 * (level + 1);
export type UpgradeTrack = "turbo" | "tank" | "suspension";

export interface UpgradeLevels { turbo: number; tank: number; suspension: number; }
export interface CarPerk { ability?: CarAbility; baseLev?: number; }
export interface PerkEnvelope {
  maxLev: number;
  maxDurSecs: number;
  minLiqFp: number;
  graceSecs: number;
  slTpAllowed: boolean;
  refundFp: number;
  maxStakeUnits: number;
}

const clampLevel = (n: number) => Math.max(0, Math.min(MAX_UPGRADE_LEVEL, Math.floor(Number(n) || 0)));
const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Add the earned Turbo bonus above whichever starting ceiling is higher. */
export function carLeverageCeiling(upgradedRmax: number, carBaseLev = 0): number {
  const turboBonus = Math.max(0, upgradedRmax - BASE_CONFIG.RMAX);
  return Math.max(BASE_CONFIG.RMAX, carBaseLev) + turboBonus;
}

/** The perk envelope a player is entitled to, from their upgrade levels + one car's perks.
 *  Mirrors the client's live computation (upgrades.ts + main.ts effRmax/effMaxSec) so a legit
 *  client request always validates, and is the authority the server signs against in Phase 2. */
export function perkEnvelope(levels: UpgradeLevels, car: CarPerk): PerkEnvelope {
  const turbo = clampLevel(levels.turbo);
  const tank = clampLevel(levels.tank);
  const susp = clampLevel(levels.suspension);
  const heavy = car.ability === "sixWheeler";

  const rmax = BASE_CONFIG.RMAX + UPGRADE_STEP.turbo * turbo;
  const ceil = carLeverageCeiling(rmax, car.baseLev);
  const nitro = car.ability === "nitro" ? NITRO_MULT : 1;
  const maxLev = clampInt(ceil * (heavy ? HEAVY.levMult : 1) * nitro, ONCHAIN.RMIN, ONCHAIN.RMAX);

  const dur = (BASE_CONFIG.MAXSEC + UPGRADE_STEP.tank * tank) * (heavy ? HEAVY.durMult : 1);
  const maxDurSecs = clampInt(dur, ONCHAIN.MIN_DUR, ONCHAIN.MAX_DUR);

  const liq = (BASE_CONFIG.LIQ + UPGRADE_STEP.suspension * susp) * 1_000_000;
  const minLiqFp = clampInt(liq, ONCHAIN.MIN_LIQ_FP, ONCHAIN.MAX_LIQ_FP);

  return {
    maxLev, maxDurSecs, minLiqFp,
    graceSecs: car.ability === "skull" ? SKULL_GRACE_SECS : 0,
    slTpAllowed: car.ability === "pinkRod",
    refundFp: car.ability === "airbag" ? AIRBAG_REFUND_FP : 0,
    maxStakeUnits: heavy ? HEAVY.playCap : DEFAULT_STAKE_UNITS,
  };
}

/** Perk-relevant fields per car, keyed by the inventory `carId` (the car's exact `name` string —
 *  case- and space-sensitive, e.g. "Six Wheeler"). Only cars with an envelope-affecting perk have
 *  an entry; everything else falls through to `{}` (stock envelope). */
export const CAR_PERKS: Record<string, CarPerk> = {
  "Cybertruck": { baseLev: 1500 },
  "Orion": { ability: "nitro" },
  "Bedrock": { ability: "airbag" },
  "Skull": { ability: "skull" },
  "Pink Rod": { ability: "pinkRod" },
  "Six Wheeler": { ability: "sixWheeler" },
};

/** Look up a car's perks by inventory carId; unknown/stock cars → no perks. */
export const carPerk = (carId: string): CarPerk => CAR_PERKS[carId] ?? {};
