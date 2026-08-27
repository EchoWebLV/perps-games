// Locked copy of the client crate + pity math. Tests pin the same vectors as redline3d/src/core.

export type Rarity = 1 | 2 | 3 | 4 | 5;
export type CrateKey = "wooden" | "silver" | "gold";

export interface CrateCar { name: string; rarity: number; pool?: boolean; comingSoon?: boolean }

export interface CrateType {
  key: CrateKey;
  priceCoins: number;
  scrap: number;
  tierWeights: Partial<Record<Rarity, number>>;
}

export const CRATES: readonly CrateType[] = [
  { key: "wooden", priceCoins: 250, scrap: 25, tierWeights: { 1: 50, 2: 30, 3: 20 } },
  { key: "silver", priceCoins: 1000, scrap: 300, tierWeights: { 1: 40, 2: 30, 3: 16, 4: 10, 5: 4 } },
  { key: "gold", priceCoins: 3000, scrap: 800, tierWeights: { 3: 40, 4: 35, 5: 25 } },
];

export const crateByKey = (key: string): CrateType => CRATES.find((c) => c.key === key) ?? CRATES[0];

export const PITY: Record<CrateKey, { topTier: Rarity; soft: number; hard: number; bump: number }> = {
  wooden: { topTier: 3, soft: 8, hard: 12, bump: 8 },
  silver: { topTier: 5, soft: 12, hard: 20, bump: 4 },
  gold: { topTier: 5, soft: 4, hard: 8, bump: 10 },
};

export const DUPE_SCRAP: Record<number, number> = { 1: 3, 2: 6, 3: 12, 4: 25, 5: 50 };

export const poolable = (c: CrateCar): boolean => c.pool !== false && !c.comingSoon;

export function bytesToDraws(bytes: Uint8Array, n: number): number[] {
  if (n * 8 > bytes.length) throw new Error(`need ${n * 8} bytes, have ${bytes.length}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Number(dv.getBigUint64(i * 8, false) >> 11n) / 2 ** 53);
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("bad_vrf_bytes");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function rollCrate(cars: CrateCar[], weights: Partial<Record<Rarity, number>>, rTier: number, rCar: number): CrateCar | null {
  const avail = ([1, 2, 3, 4, 5] as Rarity[])
    .filter((id) => (weights[id] ?? 0) > 0)
    .map((id) => ({ w: weights[id]!, pool: cars.filter((c) => (c.rarity ?? 1) === id && poolable(c)) }))
    .filter((x) => x.pool.length > 0);
  if (avail.length === 0) return null;
  const total = avail.reduce((s, x) => s + x.w, 0);
  let x = rTier * total;
  let chosen = avail[avail.length - 1];
  for (const a of avail) { if ((x -= a.w) < 0) { chosen = a; break; } }
  return chosen.pool[Math.min(chosen.pool.length - 1, Math.floor(rCar * chosen.pool.length))];
}

export function rollCrateWithPity(
  cars: CrateCar[],
  key: CrateKey,
  weights: Partial<Record<Rarity, number>>,
  misses: number,
  rTier: number,
  rCar: number,
): CrateCar | null {
  const rule = PITY[key];
  const extra = Math.max(0, misses + 1 - rule.soft);
  const used: Partial<Record<Rarity, number>> = (misses + 1 >= rule.hard)
    ? { [rule.topTier]: 100 }
    : extra > 0 ? { ...weights, [rule.topTier]: (weights[rule.topTier] ?? 0) + extra * rule.bump } : { ...weights };
  return rollCrate(cars, used, rTier, rCar);
}

export function nextPity(key: CrateKey, misses: number, rarity: number): number {
  return rarity === PITY[key].topTier ? 0 : misses + 1;
}

export const dupeScrap = (rarity: number): number => DUPE_SCRAP[Math.max(1, Math.min(5, rarity | 0))] ?? 3;

/** Live roster — must stay aligned with redline3d CAR_DEFS poolable cars. */
export const CRATE_ROSTER: CrateCar[] = [
  { name: "DeLorean", rarity: 4 },
  { name: "Cybertruck", rarity: 3 },
  { name: "Orion", rarity: 5 },
  { name: "Vaporwave", rarity: 3 },
  { name: "Bedrock", rarity: 5 },
  { name: "Clown Car", rarity: 5 },
  { name: "Cart Rod", rarity: 3 },
  { name: "Magnet", rarity: 3 },
  { name: "Helmet", rarity: 4 },
  { name: "Pink Rod", rarity: 4 },
  { name: "Six Wheeler", rarity: 4 },
  { name: "Banana", rarity: 1 },
  { name: "Big Frank", rarity: 1 },
  { name: "Dragon", rarity: 1 },
  { name: "Homewrecker", rarity: 1 },
  { name: "Copycat", rarity: 3 },
  { name: "Knockout", rarity: 3 },
  { name: "Prickle", rarity: 2 },
  { name: "The Kraken", rarity: 2 },
  { name: "Noodler", rarity: 2 },
];
