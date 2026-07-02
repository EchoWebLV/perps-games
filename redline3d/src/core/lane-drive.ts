/** 1-D lateral car dynamics for the scrolling-road racer.
 *
 *  The racer's road scrolls; the car only moves ACROSS it. The old feel bug was
 *  `carX += (target − carX) * 0.18` — a per-frame position spring: frame-rate
 *  dependent, velocity-free (no momentum, no counter-steer), with yaw faked from
 *  the remaining error. This module replaces it with a real second-order body:
 *  a PD controller steers a point mass toward the finger/keys target, the accel
 *  budget scales with road speed (a parked car is lazy, a flat-out one darts),
 *  tires bleed lateral velocity, and yaw leans with the ACTUAL velocity — so the
 *  car visibly counter-steers to arrest a swerve instead of gliding to a stop.
 *
 *  Pure TypeScript, no THREE/DOM. Integration is semi-implicit Euler + an exact
 *  exponential grip decay, which keeps 60 Hz and 120 Hz trajectories within a
 *  few cm of each other (pinned by test — exact dt-invariance is impossible with
 *  Euler, indistinguishable is what matters).
 */

export type LaneState = {
  x: number;     // lateral position on the road, world units (0 = centre)
  vx: number;    // lateral velocity, units/s — the momentum the old spring lacked
  yaw: number;   // body lean into the motion, radians (visual: rotates the car mesh)
  steer: number; // front-wheel command in [-1, 1] (visual: feeds car.setSteer)
};

export type LaneTune = {
  KP: number;       // spring toward the target
  KD: number;       // damping against lateral velocity
  A_MAX: number;    // lateral accel budget at full road speed
  GRIP: number;     // tire bleed rate on vx (s⁻¹)
  AUTH_MIN: number; // fraction of A_MAX available when parked
  YAW_GAIN: number; // radians of body lean per unit/s of vx
  YAW_MAX: number;  // yaw cap (radians)
  YAW_EASE: number; // fps-independent ease rate of yaw toward its target (s⁻¹)
  X_MAX: number;    // road half-width — both the target clamp and the hard wall
};

export const LANE_DRIVE: LaneTune = {
  KP: 80,           // stiff spring: full accel budget engages within ~1 unit of error,
                    // so the linear "docking" band is narrow and the ride is authority-limited
                    // (that's what makes road speed FELT — see AUTH_MIN)
  KD: 11.4,         // with GRIP this lands ζ≈0.75 — a whisper of underdamp: interior-lane
                    // swerves overshoot ~0.13 units then dock (juice), never float/oscillate
  A_MAX: 80,        // full-width swerve (−10→+10) settles in ~1.05s flat out — snappy dodge,
                    // not a teleport; higher started to blur the speed-authority contrast
  GRIP: 2.0,        // tire bleed on vx; at swerve speeds (~30 u/s) this is the main arresting
                    // force, which is why the wall "thunk" on a max swerve is only ~5 u/s
  AUTH_MIN: 0.18,   // parked car keeps 18% of the budget → showroom recentre from x=6 in ~1.5s.
                    // Deliberately below the spec sketch's 0.3–0.4: authority is the ONLY
                    // speed-scaled term, and ≥0.3 caps the slow/fast settle contrast at ~1.2×
                    // (structurally: settle ∝ 1/√auth) — 0.18 yields the required ≥1.5× (~1.8×)
  YAW_GAIN: 0.04,   // lean tracks REAL vx: ~7° at a 3 u/s correction, saturating in a full swerve
  YAW_MAX: 0.4,     // yaw cap ≈ the old game's visual cap (~0.36) with a hair of headroom
  YAW_EASE: 8,      // yaw catches vx in ~0.13s — leans with the move, no jelly lag
  X_MAX: 10,        // matches main.ts's carXTarget clamp (±10) — target and wall share it
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// NaN/Infinity-proof a value (a dead touch axis or a tab-suspend dt spike must not poison the car)
const finite = (v: number) => (Number.isFinite(v) ? v : 0);
// a tab coming back from the background can hand us a giant dt — integrate at most this much
const DT_MAX = 0.1;

/**
 * One step of the lateral model (pure — returns a new state):
 *   auth  = AUTH_MIN + (1−AUTH_MIN)·speedFrac      accel budget scales with road speed
 *   axRaw = KP·(target−x) − KD·vx                  PD toward the target
 *   ax    = clamp(axRaw, ±A_MAX·auth)              authority limit (the speed feel)
 *   vx    += ax·dt;  vx ·= e^(−GRIP·dt);  x += vx·dt   semi-implicit Euler + exact grip decay
 * The road edge is a hard wall: x clamps to ±X_MAX and vx dies ONLY if it points
 * further out — the car can slide off the wall but never through or stick to it.
 * Yaw leans with the ACTUAL velocity (not the error), so the body language reads
 * momentum; steer is the normalized PD demand, so the front wheels counter-steer
 * during the arrest phase of a swerve like a real driver's hands.
 *
 * @param speedFrac road speed as a fraction of top speed, clamped to [0,1]
 */
export function laneStep(
  s: LaneState,
  targetX: number,
  speedFrac: number,
  dt: number,
  tune: LaneTune = LANE_DRIVE,
): LaneState {
  const target = clamp(finite(targetX), -tune.X_MAX, tune.X_MAX);
  const f = clamp(finite(speedFrac), 0, 1);
  const h = clamp(finite(dt), 0, DT_MAX);
  // guard the incoming state too — one poisoned frame must not wedge the car forever
  const x0 = finite(s.x);
  const v0 = finite(s.vx);
  const yaw0 = finite(s.yaw);

  // authority: a slow car steers lazily, a fast one darts (AUTH_MIN > 0 keeps the
  // parked showroom car recentring)
  const auth = tune.AUTH_MIN + (1 - tune.AUTH_MIN) * f;
  const cap = tune.A_MAX * auth;

  // PD demand, then the authority clamp
  const axRaw = tune.KP * (target - x0) - tune.KD * v0;
  const ax = clamp(axRaw, -cap, cap);

  // semi-implicit Euler; grip decay is the EXACT exponential so its damping
  // contribution is dt-invariant by construction
  let vx = (v0 + ax * h) * Math.exp(-tune.GRIP * h);
  let x = x0 + vx * h;

  // hard road edge: kill vx only when it still points further out — sliding back
  // off the wall is free (no sticky wall)
  if (x > tune.X_MAX) {
    x = tune.X_MAX;
    if (vx > 0) vx = 0;
  } else if (x < -tune.X_MAX) {
    x = -tune.X_MAX;
    if (vx < 0) vx = 0;
  }

  // yaw follows the ACTUAL lateral velocity — the car leans into where it's GOING,
  // and straightens as the motion dies (the old code leaned on remaining error)
  const yawTarget = clamp(vx * tune.YAW_GAIN, -tune.YAW_MAX, tune.YAW_MAX);
  const yaw = yaw0 + (yawTarget - yaw0) * (1 - Math.exp(-tune.YAW_EASE * h));

  // front wheels show the un-clamped PD demand, normalized to the current authority:
  // pinned into a swerve, then flipped against it to brake the slide (counter-steer).
  // (cap>0 for LANE_DRIVE, but a custom tune with AUTH_MIN=0 parked would make this 0/0)
  const steer = cap > 0 ? clamp(axRaw / cap, -1, 1) : 0;

  return { x, vx, yaw, steer };
}
