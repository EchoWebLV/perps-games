export interface DriveState {
  x: number;        // body-centre world X
  z: number;        // body-centre world Z
  heading: number;  // yaw, radians; 0 faces -Z (the game's forward)
  speed: number;    // signed FORWARD component of velocity: + forward, - reverse
                    // (gears/audio/HUD consume this — a sideways slide must not rev the tach)
  steer: number;    // current front-wheel angle, radians (eased toward input)
  // world-space velocity vector — the momentum. OPTIONAL for backward compat: legacy
  // literals / spawn poses / mode entries omit them and step() derives heading×speed.
  // step() always fills them on the way out.
  vx?: number;
  vz?: number;
}
export interface DriveInput { throttle: number; steer: number }
export interface Bounds { x: number; z: number }

// arcade tuning (see docs/superpowers/specs — derived from the steering deep-research)
export const DRIVE = {
  ACCEL: 26,            // units/s² on the gas
  MAX_FWD: 28,          // top forward speed
  MAX_REV: 9,           // top reverse speed
  DRAG: 2.8,            // coast-down rate off the gas — higher = settles fast, not "slippery"
  WHEELBASE: 6,         // front-to-rear axle distance — sets the turn radius
  MAX_STEER_LOW: 0.52,  // ~30° full lock at low speed → tight parking-lot turns
  MAX_STEER_HIGH: 0.13, // ~7.5° at top speed → stable, not twitchy
  STEER_EXPO: 1.5,      // input curve: flat near centre, full lock at the edge (1.8 felt dead around centre)
  STEER_RATE: 12,       // frame-rate-independent ease rate toward the target steer angle (9 felt laggy — "janky")
  GRIP: 8,              // lateral-velocity bleed rate (s⁻¹) — tight, parking-lot grippy;
                        // high enough to approximate the old heading-railed feel closely
};

/** a full tuning preset for step() — same shape as DRIVE (future per-car tunes anchor here) */
export type DriveTune = typeof DRIVE;

/** Highway tuning: ~3.5× the lot's top speed so top gear (100×) FEELS like the racer's
 *  1000× throttle on the 3× track (lap ≈ 23s flat out). Steering authority at speed is
 *  much tighter — at 100 u/s the centerline arc (R=180) needs ~0.036 rad and the tightest
 *  inner-lane line (r=141) ~0.046 — 0.05 covers both at full speed, and easing off the gas
 *  rapidly restores authority (maxSteer is speed-interpolated). */
export const HIGHWAY_DRIVE: DriveTune = {
  ACCEL: 60,
  MAX_FWD: 100,
  MAX_REV: 14,          // scaled with the world
  DRAG: 1.6,            // longer coast — highways don't stop on a dime
  WHEELBASE: 6.5,       // slightly longer car stance = steadier at speed
  MAX_STEER_LOW: 0.5,
  MAX_STEER_HIGH: 0.05,
  STEER_EXPO: 1.5,      // matched to the lot — same hand feel across modes
  STEER_RATE: 10,       // a touch slower ease than the lot = less twitch at 100 u/s
  GRIP: 4.5,            // loose enough to carve with visible slip at 100 u/s —
                        // lifting off mid-corner lets the nose rotate in
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// frame-rate-independent approach factor: ease `cur` toward a target by `rate` per second
const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
// NaN/Infinity-proof an input axis (a dead gamepad/touch axis must not poison position/heading)
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

// LOW-SPEED RAIL: real tires don't slide at parking pace. A constant GRIP loose enough
// to carve at 100 u/s would also let the car drift at 3 u/s, which looks silly — so
// effective grip ramps steeply below RAIL_SPEED (quadratic in the shortfall keeps the
// hand-off into carve territory smooth). At/above RAIL_SPEED the preset's GRIP is pure.
const RAIL_SPEED = 12;  // u/s
const RAIL_GRIP = 180;  // extra bleed rate at standstill — rails parking maneuvers

/**
 * One step of an arcade grip-car model: a kinematic bicycle for the STEERING GEOMETRY,
 * but velocity is a world-space VECTOR that does not rotate with the body — yawing at
 * speed leaves the velocity lagging the heading (momentum you can feel), and the tires
 * bleed the lateral component at tune.GRIP (high = railed, finite = carve-with-slip).
 * The car still pivots around its REAR axle (front wheels steer), so it arcs like a
 * real vehicle and can't spin in place; yaw is driven by the FORWARD component only,
 * so sliding sideways can't steer the car. The input layer — validated by the steering
 * research — is unchanged:
 *   • expo curve on the steer input (fine control near centre, full lock at the edge)
 *   • speed-sensitive max steer angle (full lock slow, gentle fast)
 *   • frame-rate-independent easing of the wheel angle (auto-centres on release)
 *   • frame-rate-independent coast-down of the forward component ("slippery"-proof)
 * Compat contract: `speed` stays authoritative for the forward component on the way IN
 * (external code scales it, e.g. the track wall scrape) — vx/vz only carry the lateral
 * memory between steps, and are derived from heading×speed when absent (legacy states).
 * `tune` selects the tuning preset (defaults to the lot's DRIVE; pass HIGHWAY_DRIVE on the track).
 */
export function step(s: DriveState, input: DriveInput, dt: number, bounds: Bounds, tune: DriveTune = DRIVE): DriveState {
  const th = clamp(finite(input.throttle), -1, 1);

  // expo steer input: flat near centre for precision, steep at the edge for full lock
  const raw = clamp(finite(input.steer), -1, 1);
  const sIn = Math.sign(raw) * Math.pow(Math.abs(raw), tune.STEER_EXPO);

  // body frame BEFORE the yaw step (lat ⟂ fwd in the XZ plane)
  const fwdX = Math.sin(s.heading), fwdZ = -Math.cos(s.heading);
  const latX = -fwdZ, latZ = fwdX;

  // decompose the momentum: forward comes from `speed` (authoritative — see docstring),
  // lateral from the stored vector (zero for legacy states = starts perfectly railed)
  let vFwd = s.speed;
  let vLat = s.vx !== undefined && s.vz !== undefined ? s.vx * latX + s.vz * latZ : 0;

  // longitudinal: gas/reverse push along the CURRENT heading (rear wheels drive the
  // body), else coast the forward component toward 0 (fps-independent, same feel as
  // the railed model); cap by clamping the forward component ONLY — a slide must not
  // eat the throttle budget
  if (Math.abs(th) > 0.05) vFwd += th * tune.ACCEL * dt;
  else vFwd -= vFwd * approach(tune.DRAG, dt);
  vFwd = clamp(vFwd, -tune.MAX_REV, tune.MAX_FWD);

  // speed-sensitive steer authority: full lock when slow, gentle when fast
  const speedFrac = Math.min(1, Math.abs(vFwd) / tune.MAX_FWD);
  const maxSteer = tune.MAX_STEER_LOW + (tune.MAX_STEER_HIGH - tune.MAX_STEER_LOW) * speedFrac;
  const target = sIn * maxSteer;
  // ease the front wheels toward the target (auto-centres as target→0 on release)
  const steer = s.steer + (target - s.steer) * approach(tune.STEER_RATE, dt);

  // yaw: bicycle law off the FORWARD component (vFwd sign makes reverse steer correctly)
  const L = tune.WHEELBASE;
  const heading = s.heading + (vFwd / L) * Math.tan(steer) * dt;
  const nfwdX = Math.sin(heading), nfwdZ = -Math.cos(heading);
  const nlatX = -nfwdZ, nlatZ = nfwdX;

  // momentum: the velocity vector stays put in WORLD space while the body yaws —
  // re-decompose it along the new heading, so forward bleeds into lateral (drift)
  const wx = fwdX * vFwd + latX * vLat, wz = fwdZ * vFwd + latZ * vLat;
  vFwd = clamp(wx * nfwdX + wz * nfwdZ, -tune.MAX_REV, tune.MAX_FWD);
  vLat = wx * nlatX + wz * nlatZ;

  // grip: the tires bleed the lateral component — preset GRIP sets the at-speed feel,
  // the low-speed rail boost keeps parking maneuvers slip-free (see RAIL_* above)
  const shortfall = Math.max(0, 1 - Math.abs(vFwd) / RAIL_SPEED);
  vLat *= Math.exp(-(tune.GRIP + RAIL_GRIP * shortfall * shortfall) * dt);

  let vx = nfwdX * vFwd + nlatX * vLat, vz = nfwdZ * vFwd + nlatZ * vLat;

  // advance by the FULL vector (this is what makes momentum real) + the rear-axle
  // pivot swing of the body centre (same arc the railed model had)
  let x = s.x + vx * dt + (nfwdX - fwdX) * (L / 2);
  let z = s.z + vz * dt + (nfwdZ - fwdZ) * (L / 2);

  // soft walls: clamp the centre, kill ONLY the component into the clamped axis —
  // the tangential one survives, so the car slides along the wall, not a dead stop
  let hitWall = false;
  if (x > bounds.x) { x = bounds.x; vx = 0; hitWall = true; }
  else if (x < -bounds.x) { x = -bounds.x; vx = 0; hitWall = true; }
  if (z > bounds.z) { z = bounds.z; vz = 0; hitWall = true; }
  else if (z < -bounds.z) { z = -bounds.z; vz = 0; hitWall = true; }
  // wall contact changed the vector, so re-project to keep the `speed` invariant honest
  const speed = hitWall ? vx * nfwdX + vz * nfwdZ : vFwd;

  return { x, z, heading, speed, steer, vx, vz };
}
