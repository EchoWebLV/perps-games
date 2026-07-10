/** which functional building you drive into — the lobby is the economy town, not a market picker */
export type BuildingKind = "garage" | "upgrades" | "crates" | "track" | "highway" | "scrapyard";

export interface Building { kind: BuildingKind; x: number; z: number; w: number; d: number; rot: number; color: number; name: string; comingSoon?: boolean }
export interface DoorZone { kind: BuildingKind; x: number; z: number; r: number }
export interface Point { x: number; z: number }

// the drivable lot: half-extents in world units (360 x 360 — a big open plaza)
export const LOT_BOUNDS = { x: 180, z: 180 };

// TOWN SQUARE: the buildings ring a central plaza and every one faces INWARD, so from anywhere in
// the square you can read every storefront (the crescent's readability, but as an enclosed place).
// You enter from the OPEN south side and drive into the plaza; a loop road circles it. The two race
// venues (TRACK/HIGHWAY) sit at the north, facing you head-on as you come in.
export const LOBBY_SPAWN = { x: 0, z: 142.5 };

// the central plaza + its loop road, shared with the renderer so the road art and the layout can't
// drift apart. The loop sits INSIDE the door rings; you circle it and pull outward into a doorway.
export const PLAZA = {
  center: { x: 0, z: 0 } as Point,
  loopRadius: 60, // drivable loop centreline radius
  loopWidth: 33,
  entrance: { from: { x: 0, z: 150 }, to: { x: 0, z: 27 } }, // south approach into the plaza
};

// Buildings sit on a ring of radius `RING_R`, placed by compass angle (degrees clockwise from north,
// north = −Z). The south sector is left empty for the entrance. Each faces the plaza centre: a group
// rotated by `rot` maps local +Z → (sin rot, cos rot); facing the centre from angle θ means rot = −θ.
const RING_R = 108;
const RING_SPEC: Array<{ kind: BuildingKind; deg: number; w: number; d: number; color: number; name: string; comingSoon?: boolean }> = [
  // race venues — north, head-on as you enter
  { kind: "track",    deg:  35, w: 28, d: 12, color: 0x14f195, name: "TRACK" },
  { kind: "highway",  deg: -35, w: 28, d: 12, color: 0xff6a3d, name: "HIGHWAY" },
  // shops — east / west sides
  { kind: "garage",   deg:  80, w: 24, d: 16, color: 0x27e7ff, name: "GARAGE" },
  { kind: "upgrades", deg: -80, w: 24, d: 16, color: 0xffd166, name: "UPGRADES" },
  // shops — nearer the entrance corners
  { kind: "crates",   deg: 125, w: 24, d: 16, color: 0xff39c0, name: "CRATES" },
  { kind: "scrapyard",deg:-125, w: 24, d: 16, color: 0xd94a2b, name: "SCRAPYARD", comingSoon: true },
];

export const BUILDINGS: Building[] = RING_SPEC.map((s) => {
  const th = (s.deg * Math.PI) / 180;
  const x = RING_R * Math.sin(th); // + deg = east
  const z = -RING_R * Math.cos(th); // north is −Z
  const rot = -th; // turn the front (local +Z) to point back at the plaza centre
  return { kind: s.kind, x, z, w: s.w, d: s.d, rot, color: s.color, name: s.name, comingSoon: s.comingSoon };
});

// entrance trigger: a storefront-wide circle hugging each building's front apron, out toward the
// plaza — big enough to see and drive into on purpose, drawn as a glowing ring by the lobby.
// front direction = (sin rot, cos rot); step out (depth/2 + 5) from the building centre (inward).
export const DOORS: DoorZone[] = BUILDINGS.map((b) => ({
  kind: b.kind,
  x: b.x + Math.sin(b.rot) * (b.d / 2 + 5),
  z: b.z + Math.cos(b.rot) * (b.d / 2 + 5),
  r: b.w / 2 + 4,
}));

/** which doorway the point (x,z) is inside, or null */
export function entranceHit(x: number, z: number): BuildingKind | null {
  for (const d of DOORS) {
    const dx = x - d.x, dz = z - d.z;
    if (dx * dx + dz * dz <= d.r * d.r) return d.kind;
  }
  return null;
}

/** Pose for a car that just drove OUT of `kind`'s building: just outside the door ring,
 *  nose pointed back at the building (you see where you came from).
 *  Motion convention: forward = (sin heading, -cos heading). */
export function doorExitPose(kind: BuildingKind): { x: number; z: number; heading: number } | null {
  const b = BUILDINGS.find((bb) => bb.kind === kind);
  const d = DOORS.find((dd) => dd.kind === kind);
  if (!b || !d) return null;
  const fx = Math.sin(b.rot), fz = Math.cos(b.rot); // building front → plaza centre
  const out = d.r + 18; // clear of the door ring — driving off can't instantly re-trigger the entry
  return { x: d.x + fx * out, z: d.z + fz * out, heading: Math.atan2(-fx, fz) }; // forward = −front → faces the building
}
