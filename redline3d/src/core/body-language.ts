/** Cosmetic body language shared by every drive mode: eased roll into corners plus
 *  squat/dive under throttle/brake. Pure state-in/state-out (mirrors freedrive.step)
 *  so main.ts keeps only a BodyState and feeds each mode's own steer/speed/accel.
 *  Visual only — never feeds physics or money.
 */

export type BodyState = {
  roll: number;  // rotation.z component — leans INTO the turn (see the sign note on stepBody)
  pitch: number; // rotation.x component — squat (+, nose-up) on throttle, dive (−) on braking
};

// feel constants (extracted verbatim from the shipped inline bodyLanguage)
export const BODY_EASE_RATE = 10; // s⁻¹ ease toward the targets — catches a steering flick in
                                  // ~0.1s: fast enough to read as suspension, slow enough not to snap
export const ROLL_MAX = 0.09;     // ≤ ~5° of body roll at full steer + full speed
export const PITCH_MAX = 0.04;    // ≤ ~2.3° of squat/dive when |accel| reaches the mode's accelScale

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
// NaN/Infinity-proof a value (a dead input axis or a 0/0 accel must not poison the pose)
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/**
 * One step of the body-language ease (pure — returns a new state):
 *   rollT  = −steerFrac · speedFrac · ROLL_MAX
 *   pitchT = clamp(accel / accelScale, ±1) · PITCH_MAX
 *   both ease toward their targets fps-independently (factor 1 − e^(−BODY_EASE_RATE·dt))
 *
 * Roll sign: the car leans INTO the turn. All modes pose the car with the
 * rotation.z = −steerFrac·k convention — steering toward +x (positive steerFrac)
 * rolls z negative, which tips the roof toward the inside of the turn.
 *
 * @param steerFrac  normalized steer in [−1,1] (freedrive: steer/MAX_STEER_LOW; racer: lane.steer)
 * @param speedFrac  speed as a fraction of the mode's top speed, [0,1] — no roll while parked
 * @param accel      longitudinal accel, units/s² (derived from the mode's speed delta)
 * @param accelScale accel magnitude that produces FULL squat/dive (each mode names its own)
 */
export function stepBody(
  body: BodyState,
  steerFrac: number,
  speedFrac: number,
  accel: number,
  accelScale: number,
  dt: number,
): BodyState {
  const h = Math.max(0, finite(dt));
  const ease = 1 - Math.exp(-BODY_EASE_RATE * h); // fps-independent approach factor
  const rollT = -clamp(finite(steerFrac), -1, 1) * clamp(finite(speedFrac), 0, 1) * ROLL_MAX;
  const scale = finite(accelScale);
  const pitchT = (scale > 0 ? clamp(finite(accel) / scale, -1, 1) : 0) * PITCH_MAX;
  const roll0 = finite(body.roll);
  const pitch0 = finite(body.pitch);
  return {
    roll: roll0 + (rollT - roll0) * ease,
    pitch: pitch0 + (pitchT - pitch0) * ease,
  };
}
