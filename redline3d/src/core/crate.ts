// The crate opener's core: three crate tiers, each with its own price, scrap payout, and car-rarity
// odds; plus a duplicate's Scrap value. Pure + deterministic (takes the random draws as args) so it's
// fully testable; the live opener feeds draws from a RandomnessProvider — client RNG now, MagicBlock
// VRF behind the same port later.

import { sha256 } from "viem";
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
// can't drop from that crate. `priceSol` is the confirmed native devnet SOL purchase option.
export interface CrateType {
  key: "wooden" | "silver" | "gold";
  name: string;
  color: string;                          // UI accent (crate identity)
  priceCoins: number;
  priceSol?: number;
  scrap: number;                          // guaranteed scrap per open
  levelChance: number;                    // chance (0..1) to also unlock a random locked level skin
  tierWeights: Partial<Record<Rarity, number>>;
}
export const CRATES: readonly CrateType[] = [
  { key: "wooden", name: "Wooden Crate", color: "#b07a45", priceCoins: 250, scrap: 25, levelChance: 0.05, tierWeights: { 1: 50, 2: 30, 3: 20 } },
  { key: "silver", name: "Silver Crate", color: "#c3ccd8", priceCoins: 1000, priceSol: 0.1, scrap: 300, levelChance: 0.25, tierWeights: { 1: 40, 2: 30, 3: 16, 4: 10, 5: 4 } },
  { key: "gold",   name: "Gold Crate",   color: "#ffcf5a", priceCoins: 3000, priceSol: 0.2, scrap: 800, levelChance: 0.75, tierWeights: { 3: 40, 4: 35, 5: 25 } },
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

// ── commit-reveal proof (server-proven crate randomness) ─────────────────────────────────────────
// The server publishes `commitment = sha256(seed‖nonce)` BEFORE the player opens, then reveals seed
// and nonce with the result. Re-deriving both here is what makes the roll provable: the server could
// not have chosen the outcome after seeing the crate, and it cannot swap the seed afterwards.

/** hex → bytes, tolerating an 0x prefix and either case. Throws on anything that isn't clean hex. */
function hexBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) throw new Error("bad_hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The server's published derivation, byte-for-byte: draw[i] = sha256(seed‖[i])[0..4) / 2^32. */
export function drawsFromSeed(seedHex: string, n: number): number[] {
  const seed = hexBytes(seedHex);
  return Array.from({ length: n }, (_, i) => {
    const buf = new Uint8Array(seed.length + 1);
    buf.set(seed); buf[seed.length] = i;
    return parseInt(sha256(buf).slice(2, 10), 16) / 2 ** 32;
  });
}

export interface CrateRevealed { seedHex: string; nonceHex: string; commitment: string }
export type CrateProof =
  | { ok: true; /** false when the response echoed no draws, so only the commitment was checked. */ checkedDraws: boolean }
  | { ok: false; reason: "missing_reveal" | "commitment_mismatch" | "draws_mismatch" };

/** Draws compare exactly: both sides derive them from the same bytes, so any drift is tampering. */
const sameDraws = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Check an open against the commitment the server published beforehand. Fails CLOSED — a malformed
 * or absent reveal is a refusal, never a pass. `draws` is optional: when the response echoes the
 * draws the outcome was rolled from, they are re-derived too (`checkedDraws: true`).
 */
export function verifyCrateOpen(input: {
  commitment: string;
  reveal?: CrateRevealed | null;
  draws?: number[] | null;
}): CrateProof {
  const { commitment, reveal, draws } = input;
  if (!reveal || !commitment) return { ok: false, reason: "missing_reveal" };
  let recomputed: string;
  try {
    const seed = hexBytes(reveal.seedHex);
    const nonce = hexBytes(reveal.nonceHex);
    const joined = new Uint8Array(seed.length + nonce.length);
    joined.set(seed); joined.set(nonce, seed.length);
    recomputed = sha256(joined).slice(2);
  } catch {
    return { ok: false, reason: "commitment_mismatch" };
  }
  const want = commitment.trim().toLowerCase().replace(/^0x/, "");
  const echoed = reveal.commitment.trim().toLowerCase().replace(/^0x/, "");
  if (recomputed !== want || echoed !== want) return { ok: false, reason: "commitment_mismatch" };
  if (!draws || draws.length === 0) return { ok: true, checkedDraws: false };
  if (!sameDraws(draws, drawsFromSeed(reveal.seedHex, draws.length))) {
    return { ok: false, reason: "draws_mismatch" };
  }
  return { ok: true, checkedDraws: true };
}
