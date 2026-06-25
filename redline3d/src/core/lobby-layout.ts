/** which functional building you drive into — the lobby is the economy town, not a market picker */
export type BuildingKind = "garage" | "upgrades" | "crates" | "track";

export interface Building { kind: BuildingKind; x: number; z: number; w: number; d: number; color: number; name: string }
export interface DoorZone { kind: BuildingKind; x: number; z: number; r: number }

// the drivable lot: half-extents in world units (120 x 120)
export const LOT_BOUNDS = { x: 60, z: 60 };

// four functional storefronts in a row along the far (-Z) end of the lot.
// Garage = your cars · Upgrades = tune your car · Crates = (coming soon) · Track = race.
export const BUILDINGS: Building[] = [
  { kind: "garage", x: -45, z: -44, w: 20, d: 14, color: 0x27e7ff, name: "GARAGE" },
  { kind: "upgrades", x: -15, z: -44, w: 20, d: 14, color: 0xffd166, name: "UPGRADES" },
  { kind: "crates", x: 15, z: -44, w: 20, d: 14, color: 0xff39c0, name: "CRATES" },
  { kind: "track", x: 45, z: -44, w: 20, d: 14, color: 0x14f195, name: "TRACK" },
];

// entrance trigger: a circle just in front (+Z side) of each building's door
export const DOORS: DoorZone[] = BUILDINGS.map((b) => ({ kind: b.kind, x: b.x, z: b.z + b.d / 2 + 5, r: 6 }));

/** which doorway the point (x,z) is inside, or null */
export function entranceHit(x: number, z: number): BuildingKind | null {
  for (const d of DOORS) {
    const dx = x - d.x, dz = z - d.z;
    if (dx * dx + dz * dz <= d.r * d.r) return d.kind;
  }
  return null;
}
