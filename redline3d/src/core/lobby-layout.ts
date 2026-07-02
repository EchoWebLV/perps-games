/** which functional building you drive into — the lobby is the economy town, not a market picker */
export type BuildingKind = "garage" | "upgrades" | "crates" | "track" | "highway";

export interface Building { kind: BuildingKind; x: number; z: number; w: number; d: number; rot: number; color: number; name: string }
export interface DoorZone { kind: BuildingKind; x: number; z: number; r: number }

// the drivable lot: half-extents in world units (240 x 240 — a big open plaza)
export const LOT_BOUNDS = { x: 120, z: 120 };

// You spawn here (south of the arc), facing north into the plaza. The rest of the big lot opens
// out to the south and sides for free driving.
export const LOBBY_SPAWN = { x: 0, z: 52 };

// The four storefronts sit along a shallow ARC across one (north) end of the lot, cupping the open
// plaza. `ARC` is the focus the crescent wraps around; each building faces that focus, so the whole
// row faces the approaching player. Positions + facing are derived from the arc so it stays tunable.
// Garage = your cars · Upgrades = tune · Crates = (soon) · Track = race.
const ARC = { cx: 0, cz: 15, r: 72 };
const ARC_SPEC: Array<{ kind: BuildingKind; deg: number; w: number; d: number; color: number; name: string }> = [
  { kind: "garage", deg: -49, w: 26, d: 16, color: 0x27e7ff, name: "GARAGE" },
  { kind: "upgrades", deg: -16.5, w: 20, d: 20, color: 0xffd166, name: "UPGRADES" },
  { kind: "crates", deg: 16.5, w: 26, d: 18, color: 0xff39c0, name: "CRATES" },
  { kind: "track", deg: 49, w: 30, d: 12, color: 0x14f195, name: "TRACK" },
  { kind: "highway", deg: 81, w: 30, d: 12, color: 0x27ff9d, name: "HIGHWAY" },
];

export const BUILDINGS: Building[] = ARC_SPEC.map((s) => {
  const a = (s.deg * Math.PI) / 180;
  const x = ARC.cx + ARC.r * Math.sin(a); // + deg = east
  const z = ARC.cz - ARC.r * Math.cos(a); // north is −Z, so the arc bows away from the plaza
  // heading that turns the building's local +Z (its front) to face the arc focus: a group rotated
  // by rot maps local +Z → (sin rot, cos rot); we want that = normalize(focus − pos).
  const rot = Math.atan2(ARC.cx - x, ARC.cz - z);
  return { kind: s.kind, x, z, w: s.w, d: s.d, rot, color: s.color, name: s.name };
});

// entrance trigger: a circle just in front of each building's door, out toward the plaza/focus.
// front direction = (sin rot, cos rot); step out (depth/2 + 6) from the building centre.
export const DOORS: DoorZone[] = BUILDINGS.map((b) => ({
  kind: b.kind,
  x: b.x + Math.sin(b.rot) * (b.d / 2 + 6),
  z: b.z + Math.cos(b.rot) * (b.d / 2 + 6),
  r: 7,
}));

/** which doorway the point (x,z) is inside, or null */
export function entranceHit(x: number, z: number): BuildingKind | null {
  for (const d of DOORS) {
    const dx = x - d.x, dz = z - d.z;
    if (dx * dx + dz * dz <= d.r * d.r) return d.kind;
  }
  return null;
}
