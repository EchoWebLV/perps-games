import type { DriveState } from "./freedrive";

/** Stadium oval: two straights along Z at x=±R joined by semicircular arcs.
 *  All units are world units (the lobby lot is 240×240 for scale). */
export const TRACK = {
  R: 180,          // centerline arc radius
  STRAIGHT: 600,   // straight length
  MEDIAN_HALF: 4,  // half-width of the raised median (a hard barrier — no crossing)
  LANE_W: 12,      // one lane; a carriageway is LANES lanes
  LANES: 3,        // lanes per carriageway — a real highway
  EDGE: 40,        // median centerline → outer barrier (MEDIAN_HALF + LANES·LANE_W)
  WALL_PAD: 1.0,   // car half-width buffer against median/barrier
};

/** total centerline length */
export const LEN = 2 * TRACK.STRAIGHT + 2 * Math.PI * TRACK.R;

/** generous rectangular bounds handed to freedrive.step — contain() is the real wall
 *  (x extent = R+EDGE = 220; z extent = STRAIGHT/2 + R + EDGE = 520) */
export const HW_BOUNDS = { x: 400, z: 700 };

/** exponential speed-decay rate (s⁻¹) while scraping a wall — sliding, not a dead stop */
export const WALL_SCRAPE = 1.4;

/** road elevation at arc length s: two gentle overlapping hills per lap (≈0..11 units).
 *  Purely visual — the driving model stays flat; the renderer and the car's y/pitch read this. */
export function elevationAt(s: number): number {
  const t = ((s % LEN) + LEN) % LEN;
  return 4 * (1 - Math.cos((4 * Math.PI * t) / LEN)) + 1.5 * (1 - Math.cos((2 * Math.PI * t) / LEN + 1.3));
}

export interface TrackPoint { x: number; z: number; heading: number }
export interface TrackProgress { s: number; lateralOffset: number; tangentHeading: number }

const { R, STRAIGHT, MEDIAN_HALF, EDGE, WALL_PAD, LANE_W } = TRACK;
const HALF = STRAIGHT / 2;

/** centerline point + forward tangent heading at arc length s (wraps). Heading 0 faces −Z. */
export function sample(s: number): TrackPoint {
  let t = s % LEN;
  if (t < 0) t += LEN;
  if (t < STRAIGHT) {
    // east straight, north-bound: (R, HALF) → (R, −HALF)
    return { x: R, z: HALF - t, heading: 0 };
  }
  t -= STRAIGHT;
  if (t < Math.PI * R) {
    // north arc, center (0, −HALF): θ 0→π sweeps east → west over the top
    const th = t / R;
    return { x: R * Math.cos(th), z: -HALF - R * Math.sin(th), heading: -th };
  }
  t -= Math.PI * R;
  if (t < STRAIGHT) {
    // west straight, south-bound: (−R, −HALF) → (−R, HALF)
    return { x: -R, z: -HALF + t, heading: Math.PI };
  }
  t -= STRAIGHT;
  // south arc, center (0, HALF): θ 0→π sweeps west → east under the bottom
  const th = t / R;
  return { x: -R * Math.cos(th), z: HALF + R * Math.sin(th), heading: Math.PI - th };
}

/** project a world point onto the centerline. lateralOffset > 0 = right of
 *  increasing-s travel = the OUTER side of the loop. */
export function progress(x: number, z: number): TrackProgress {
  if (z < -HALF) {
    // north arc: radial projection around (0, −HALF)
    const dx = x, dz = z + HALF;
    const th = Math.atan2(-dz, dx); // pos = (r cosθ, −r sinθ) rel. center, θ ∈ [0, π]
    const r = Math.hypot(dx, dz);
    return { s: STRAIGHT + th * R, lateralOffset: r - R, tangentHeading: -th };
  }
  if (z > HALF) {
    // south arc: radial projection around (0, HALF)
    const dx = x, dz = z - HALF;
    const th = Math.atan2(dz, -dx); // pos = (−r cosθ, r sinθ) rel. center, θ ∈ [0, π]
    const r = Math.hypot(dx, dz);
    return { s: 2 * STRAIGHT + Math.PI * R + th * R, lateralOffset: r - R, tangentHeading: Math.PI - th };
  }
  if (x >= 0) {
    // east straight (north-bound): right of travel = +x (outward)
    return { s: HALF - z, lateralOffset: x - R, tangentHeading: 0 };
  }
  // west straight (south-bound): right of travel = −x (outward)
  return { s: STRAIGHT + Math.PI * R + (z + HALF), lateralOffset: -(x + R), tangentHeading: Math.PI };
}

/** clamp a point onto the drivable ribbon of ITS OWN side of the median.
 *  The median (|lat| < MEDIAN_HALF) and the outer barrier (|lat| > EDGE) are walls. */
export function contain(x: number, z: number): { x: number; z: number; hitWall: boolean } {
  const p = progress(x, z);
  const side = p.lateralOffset >= 0 ? 1 : -1;
  const mag = Math.abs(p.lateralOffset);
  const lo = MEDIAN_HALF + WALL_PAD, hi = EDGE - WALL_PAD;
  const clamped = Math.max(lo, Math.min(hi, mag));
  const c = sample(p.s);
  // right-hand normal of increasing-s travel
  const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
  return {
    x: c.x + rx * side * clamped,
    z: c.z + rz * side * clamped,
    hitWall: Math.abs(clamped - mag) > 1e-9,
  };
}

/** on-ramp pose: LONG (dir=1) in the outer carriageway going increasing-s,
 *  SHORT (dir=−1) in the inner carriageway going the other way. Stationary. */
export function spawnPose(dir: 1 | -1): DriveState {
  const s0 = 180; // partway down the east straight
  const c = sample(s0);
  const lat = dir * (MEDIAN_HALF + LANE_W / 2); // inner lane of your carriageway
  const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
  const heading = dir === 1 ? c.heading : c.heading + Math.PI;
  return { x: c.x + rx * lat, z: c.z + rz * lat, heading, speed: 0, steer: 0 };
}
