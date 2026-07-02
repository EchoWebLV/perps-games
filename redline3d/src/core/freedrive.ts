export interface DriveState {
  x: number;        // body-centre world X
  z: number;        // body-centre world Z
  heading: number;  // yaw, radians; 0 faces -Z (the game's forward)
  speed: number;    // signed: + forward, - reverse
  steer: number;    // current front-wheel angle, radians (eased toward input)
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
  STEER_EXPO: 1.8,      // input curve: flat near centre, full lock only at the edge
  STEER_RATE: 9,        // frame-rate-independent ease rate toward the target steer angle
};

/** Highway tuning: ~3.5× the lot's top speed so top gear (100×) FEELS like the racer's
 *  1000× throttle on the 3× track (lap ≈ 23s flat out). Steering authority at speed is
 *  much tighter — at 100 u/s the arcs (R=180) need ~0.036 rad; 0.05 leaves 1.4× headroom
 *  without letting a twitch put you in the wall. */
export const HIGHWAY_DRIVE: typeof DRIVE = {
  ACCEL: 60,
  MAX_FWD: 100,
  MAX_REV: 14,
  DRAG: 1.6,
  WHEELBASE: 6.5,
  MAX_STEER_LOW: 0.5,
  MAX_STEER_HIGH: 0.05,
  STEER_EXPO: 1.8,
  STEER_RATE: 8,
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// frame-rate-independent approach factor: ease `cur` toward a target by `rate` per second
const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/**
 * One step of a kinematic bicycle model with an arcade input layer. The car pivots
 * around its REAR axle (front wheels steer), so it arcs like a real vehicle and can't
 * spin in place. The input layer — validated by the steering research — is what makes
 * it feel right:
 *   • expo curve on the steer input (fine control near centre, full lock at the edge)
 *   • speed-sensitive max steer angle (full lock slow, gentle fast)
 *   • frame-rate-independent easing of the wheel angle (auto-centres on release)
 *   • frame-rate-independent coast-down so it settles instead of gliding ("slippery")
 * `tune` selects the tuning preset (defaults to the lot's DRIVE; pass HIGHWAY_DRIVE on the track).
 */
export function step(s: DriveState, input: DriveInput, dt: number, bounds: Bounds, tune: typeof DRIVE = DRIVE): DriveState {
  const th = clamp(input.throttle, -1, 1);

  // expo steer input: flat near centre for precision, steep at the edge for full lock
  const raw = clamp(input.steer, -1, 1);
  const sIn = Math.sign(raw) * Math.pow(Math.abs(raw), tune.STEER_EXPO);

  // longitudinal: gas/reverse, else coast toward 0 (fps-independent so it isn't slippery)
  let v = s.speed;
  if (Math.abs(th) > 0.05) v += th * tune.ACCEL * dt;
  else v -= v * approach(tune.DRAG, dt);
  v = clamp(v, -tune.MAX_REV, tune.MAX_FWD);

  // speed-sensitive steer authority: full lock when slow, gentle when fast
  const speedFrac = Math.min(1, Math.abs(v) / tune.MAX_FWD);
  const maxSteer = tune.MAX_STEER_LOW + (tune.MAX_STEER_HIGH - tune.MAX_STEER_LOW) * speedFrac;
  const target = sIn * maxSteer;
  // ease the front wheels toward the target (auto-centres as target→0 on release)
  const steer = s.steer + (target - s.steer) * approach(tune.STEER_RATE, dt);

  const L = tune.WHEELBASE;
  // rear axle from the current centre, along the current heading
  const fwdX = Math.sin(s.heading), fwdZ = -Math.cos(s.heading);
  let rx = s.x - fwdX * (L / 2), rz = s.z - fwdZ * (L / 2);
  // advance the rear axle, then pivot about it (v sign makes reverse steer correctly)
  rx += fwdX * v * dt; rz += fwdZ * v * dt;
  const heading = s.heading + (v / L) * Math.tan(steer) * dt;
  // recover the body centre from the new heading
  const nfwdX = Math.sin(heading), nfwdZ = -Math.cos(heading);
  let x = rx + nfwdX * (L / 2), z = rz + nfwdZ * (L / 2);

  // soft walls: clamp the centre, kill speed on contact
  if (x > bounds.x) { x = bounds.x; v = 0; }
  else if (x < -bounds.x) { x = -bounds.x; v = 0; }
  if (z > bounds.z) { z = bounds.z; v = 0; }
  else if (z < -bounds.z) { z = -bounds.z; v = 0; }

  return { x, z, heading, speed: v, steer };
}
