import { describe, expect, test } from "vitest";
import { BODY_EASE_RATE, PITCH_MAX, ROLL_MAX, stepBody, type BodyState } from "./body-language";

const ZERO: BodyState = { roll: 0, pitch: 0 };

/** run stepBody with constant inputs for `seconds` at a fixed frame rate */
function run(hz: number, seconds: number, steer: number, speed: number, accel: number, scale: number): BodyState {
  const dt = 1 / hz;
  let b = ZERO;
  for (let t = 0; t < seconds * hz; t++) b = stepBody(b, steer, speed, accel, scale, dt);
  return b;
}

describe("body-language (shared drive-mode roll/pitch)", () => {
  test("ease is fps-independent: 60 Hz and 144 Hz agree after the same wall time", () => {
    // constant targets + the exact exponential per step ⇒ composition is exact,
    // so the two rates must land on the SAME angle, not merely nearby
    const a = run(60, 1, 0.8, 1, 13, 26);
    const b = run(144, 1, 0.8, 1, 13, 26);
    expect(a.roll).toBeCloseTo(b.roll, 10);
    expect(a.pitch).toBeCloseTo(b.pitch, 10);
    // and both sit exactly on the analytic 1s value — rate-agnostic, survives a retune
    const settled = 1 - Math.exp(-BODY_EASE_RATE * 1);
    expect(a.roll).toBeCloseTo(-0.8 * ROLL_MAX * settled, 10);
    expect(a.pitch).toBeCloseTo(0.5 * PITCH_MAX * settled, 10);
  });

  test("accel clamps at ±accelScale: a monster launch can't fold the car in half", () => {
    const up = run(60, 2, 0, 0, 9999, 26);   // way past the scale → full squat, no more
    const down = run(60, 2, 0, 0, -9999, 26); // slam the brakes → full dive, no more
    expect(up.pitch).toBeCloseTo(PITCH_MAX, 5);
    expect(down.pitch).toBeCloseTo(-PITCH_MAX, 5);
  });

  test("dt = 0 is a no-op", () => {
    const b: BodyState = { roll: 0.03, pitch: -0.01 };
    const out = stepBody(b, 1, 1, 100, 26, 0);
    expect(out.roll).toBe(b.roll);
    expect(out.pitch).toBe(b.pitch);
  });

  test("roll leans INTO the turn: steer right (+) at speed → negative roll (−steer·k convention)", () => {
    const b = stepBody(ZERO, 1, 1, 0, 26, 1 / 60);
    expect(b.roll).toBeLessThan(0);
    // and no lean while parked, whatever the wheel does (speedFrac gates it)
    const parked = stepBody(ZERO, 1, 0, 0, 26, 1 / 60);
    expect(parked.roll).toBe(0);
  });

  test("NaN/Infinity inputs never poison the pose", () => {
    let b: BodyState = { roll: NaN, pitch: Infinity };
    b = stepBody(b, NaN, Infinity, NaN, 0, NaN); // accelScale 0 would be 0/0 too
    expect(Number.isFinite(b.roll)).toBe(true);
    expect(Number.isFinite(b.pitch)).toBe(true);
    // a healthy step right after fully recovers toward real targets
    b = stepBody(b, 0.5, 1, 13, 26, 1);
    expect(b.roll).toBeCloseTo(-0.5 * ROLL_MAX, 3);
    expect(b.pitch).toBeCloseTo(0.5 * PITCH_MAX, 3);
  });
});
