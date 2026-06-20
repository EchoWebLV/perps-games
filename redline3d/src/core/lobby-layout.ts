export type Asset = "SOL" | "BTC" | "ETH";

export interface Building { asset: Asset; x: number; z: number; w: number; d: number; color: number; name: string }
export interface DoorZone { asset: Asset; x: number; z: number; r: number }

// the drivable lot: half-extents in world units (120 x 120)
export const LOT_BOUNDS = { x: 60, z: 60 };

// three buildings along the far (-Z) end of the lot
export const BUILDINGS: Building[] = [
  { asset: "BTC", x: -34, z: -42, w: 20, d: 14, color: 0xf7931a, name: "BITCOIN" },
  { asset: "ETH", x: 0, z: -48, w: 18, d: 14, color: 0x7c8cff, name: "ETHEREUM" },
  { asset: "SOL", x: 34, z: -42, w: 20, d: 14, color: 0x14f195, name: "SOLANA" },
];

// entrance trigger: a circle just in front (+Z side) of each building's door
export const DOORS: DoorZone[] = BUILDINGS.map((b) => ({ asset: b.asset, x: b.x, z: b.z + b.d / 2 + 5, r: 6 }));

/** which doorway the point (x,z) is inside, or null */
export function entranceHit(x: number, z: number): Asset | null {
  for (const d of DOORS) {
    const dx = x - d.x, dz = z - d.z;
    if (dx * dx + dz * dz <= d.r * d.r) return d.asset;
  }
  return null;
}
