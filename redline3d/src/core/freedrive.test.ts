import { describe, it, expect } from "vitest";
import { step, DRIVE, HIGHWAY_DRIVE, type DriveState } from "./freedrive";
import { TRACK } from "./track";

const BOUNDS = { x: 60, z: 60 };
const spawn = (): DriveState => ({ x: 0, z: 0, heading: 0, speed: 0, steer: 0 });
const drive = (s: DriveState, input: { throttle: number; steer: number }, frames: number) => {
  for (let i = 0; i < frames; i++) s = step(s, input, 1 / 60, BOUNDS);
  return s;
};

describe("freedrive.step (kinematic bicycle + arcade input layer)", () => {
  it("accelerates forward (-Z) under full gas, no drift with no steer", () => {
    const s = drive(spawn(), { throttle: 1, steer: 0 }, 30);
    expect(s.speed).toBeGreaterThan(0);
    expect(s.z).toBeLessThan(0); // heading 0 drives toward -Z
    expect(Math.abs(s.x)).toBeLessThan(1e-6);
  });

  it("coasts to a stop when throttle is released", () => {
    const s = drive({ ...spawn(), speed: 20 }, { throttle: 0, steer: 0 }, 600);
    expect(Math.abs(s.speed)).toBeLessThan(0.5);
  });

  it("reverses under negative throttle", () => {
    const s = drive(spawn(), { throttle: -1, steer: 0 }, 30);
    expect(s.speed).toBeLessThan(0);
    expect(s.z).toBeGreaterThan(0); // backing up moves toward +Z
  });

  it("does not turn while parked (no pivoting in place)", () => {
    const s = drive(spawn(), { throttle: 0, steer: 1 }, 30);
    expect(s.heading).toBe(0);
  });

  it("arcs while moving and the front wheels turn toward the input", () => {
    const s = drive({ ...spawn(), speed: 18 }, { throttle: 1, steer: 1 }, 12);
    expect(s.heading).not.toBe(0);            // car yawed
    expect(s.steer).toBeGreaterThan(0);       // wheels eased toward the lock
    expect(s.steer).toBeLessThanOrEqual(DRIVE.MAX_STEER_LOW + 1e-9);
  });

  it("auto-centres the wheels when the steer input is released", () => {
    let s = drive({ ...spawn(), speed: 10 }, { throttle: 1, steer: 1 }, 20);
    expect(s.steer).toBeGreaterThan(0.05);
    s = drive(s, { throttle: 1, steer: 0 }, 30); // let go of the steer
    expect(Math.abs(s.steer)).toBeLessThan(0.02);
  });

  it("steers more at low speed than at high speed (speed-sensitive authority)", () => {
    const slow = drive({ ...spawn(), speed: 4 }, { throttle: 0.01, steer: 1 }, 40);
    const fast = drive({ ...spawn(), speed: DRIVE.MAX_FWD }, { throttle: 1, steer: 1 }, 40);
    expect(slow.steer).toBeGreaterThan(fast.steer);
  });

  it("applies an expo curve: half input gives well under half the steer of full input", () => {
    const half = drive({ ...spawn(), speed: 4 }, { throttle: 0.01, steer: 0.5 }, 60);
    const full = drive({ ...spawn(), speed: 4 }, { throttle: 0.01, steer: 1 }, 60);
    expect(half.steer / full.steer).toBeLessThan(0.45); // 0.5^1.5 ≈ 0.354 (expo retuned 1.8→1.5)
  });

  it("steering reverses sense when backing up", () => {
    const fwd = step({ ...spawn(), speed: 12, steer: 0.3 }, { throttle: 1, steer: 1 }, 1 / 60, BOUNDS);
    const rev = step({ ...spawn(), speed: -12, steer: 0.3 }, { throttle: -1, steer: 1 }, 1 / 60, BOUNDS);
    expect(Math.sign(fwd.heading)).toBe(-Math.sign(rev.heading));
  });

  it("clamps speed to the max", () => {
    const big = { x: 1e6, z: 1e6 };
    let s = spawn();
    for (let i = 0; i < 600; i++) s = step(s, { throttle: 1, steer: 0 }, 1 / 60, big);
    expect(s.speed).toBeLessThanOrEqual(DRIVE.MAX_FWD + 1e-6);
    expect(s.speed).toBeCloseTo(DRIVE.MAX_FWD, 5);
  });

  it("stops at the lot wall and cannot escape bounds", () => {
    const s = drive({ ...spawn(), z: -58, speed: DRIVE.MAX_FWD }, { throttle: 1, steer: 0 }, 200);
    expect(s.z).toBeGreaterThanOrEqual(-60 - 1e-6);
    expect(s.z).toBeCloseTo(-60, 5);
    expect(s.speed).toBe(0);
  });
});

// ——— arcade grip model: velocity is a world-space vector with lateral tire grip ———
// drift angle = |velocity bearing − heading| in degrees (0 when velocity is railed to heading)
const driftDeg = (s: DriveState) => {
  const bearing = Math.atan2(s.vx!, -s.vz!); // same convention as heading: 0 faces −Z
  let d = bearing - s.heading;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return (Math.abs(d) * 180) / Math.PI;
};
const BIG = { x: 1e9, z: 1e9 };

describe("arcade grip model (vector momentum + lateral grip)", () => {
  it("momentum exists: velocity direction lags the heading in a snap turn at highway speed", () => {
    let s: DriveState = { x: 0, z: 0, heading: 0, speed: HIGHWAY_DRIVE.MAX_FWD, steer: 0 };
    let maxDrift = 0;
    for (let i = 0; i < 18; i++) { // 0.3s of full lock, flat out
      s = step(s, { throttle: 1, steer: 1 }, 1 / 60, BIG, HIGHWAY_DRIVE);
      maxDrift = Math.max(maxDrift, driftDeg(s));
    }
    expect(maxDrift).toBeGreaterThan(2); // the car carves with visible slip — not railed
  });

  it("grip reels it back: drift decays toward zero within ~1s of releasing the steer", () => {
    let s: DriveState = { x: 0, z: 0, heading: 0, speed: HIGHWAY_DRIVE.MAX_FWD, steer: 0 };
    for (let i = 0; i < 18; i++) s = step(s, { throttle: 1, steer: 1 }, 1 / 60, BIG, HIGHWAY_DRIVE);
    expect(driftDeg(s)).toBeGreaterThan(2); // drift built up
    for (let i = 0; i < 60; i++) s = step(s, { throttle: 1, steer: 0 }, 1 / 60, BIG, HIGHWAY_DRIVE);
    expect(driftDeg(s)).toBeLessThan(0.5); // tires reeled the velocity back onto the heading
  });

  it("stays railed at parking speeds even at full lock (no silly low-speed drifting)", () => {
    for (const tune of [DRIVE, HIGHWAY_DRIVE]) {
      let s: DriveState = { x: 0, z: 0, heading: 0, speed: 4.8, steer: 0 };
      let maxDrift = 0;
      for (let i = 0; i < 60; i++) { // coasts down from 4.8 — whole window is parking pace
        s = step(s, { throttle: 0, steer: 1 }, 1 / 60, BIG, tune);
        maxDrift = Math.max(maxDrift, driftDeg(s));
      }
      expect(maxDrift).toBeLessThan(0.5);
    }
  });

  it("speed reads only the forward component during a slide (tach can't rev sideways)", () => {
    // heading 0 (forward = −Z): 30 u/s forward + 20 u/s sideways momentum
    const s0: DriveState = { x: 0, z: 0, heading: 0, speed: 30, steer: 0, vx: 20, vz: -30 };
    const s = step(s0, { throttle: 0, steer: 0 }, 1 / 60, BIG, HIGHWAY_DRIVE);
    expect(s.speed).toBeGreaterThan(28); // ≈ the drag-decayed forward 30, not hypot(20,30)≈36
    expect(s.speed).toBeLessThan(30);
    expect(Math.abs(s.speed)).toBeLessThanOrEqual(Math.hypot(s.vx!, s.vz!) + 1e-9);
    expect(Math.hypot(s.vx!, s.vz!)).toBeGreaterThan(Math.abs(s.speed) + 1); // lateral memory survives the step
  });

  it("legacy state without vx/vz steps identically to an explicitly seeded one", () => {
    const h = 0.83, v = 17;
    const legacy: DriveState = { x: 3, z: -2, heading: h, speed: v, steer: 0.1 };
    const seeded: DriveState = { ...legacy, vx: Math.sin(h) * v, vz: -Math.cos(h) * v };
    const input = { throttle: 0.7, steer: -0.4 };
    const a = step(legacy, input, 1 / 60, BOUNDS);
    const b = step(seeded, input, 1 / 60, BOUNDS);
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-12);
    expect(Math.abs(a.z - b.z)).toBeLessThan(1e-12);
    expect(Math.abs(a.heading - b.heading)).toBeLessThan(1e-12);
    expect(Math.abs(a.speed - b.speed)).toBeLessThan(1e-12);
  });

  it("wall contact kills only the axis into the wall — the car slides along it", () => {
    // 45° heading: diagonal momentum into the +X wall while also moving −Z
    const h = Math.PI / 4;
    const s0: DriveState = { x: 59.9, z: 0, heading: h, speed: 20, steer: 0 };
    const s = step(s0, { throttle: 0, steer: 0 }, 1 / 60, BOUNDS);
    expect(s.x).toBe(BOUNDS.x); // clamped at the wall
    expect(s.vx).toBe(0);       // the INTO-wall component died…
    expect(s.vz).toBeLessThan(0); // …but the tangential one survived
    expect(s.z).toBeLessThan(s0.z);
    const s2 = step(s, { throttle: 0, steer: 0 }, 1 / 60, BOUNDS);
    expect(s2.z).toBeLessThan(s.z); // still sliding along the wall the next frame
  });

  it("NaN inputs cannot poison the state", () => {
    const s = step({ ...spawn(), speed: 15 }, { throttle: NaN, steer: NaN }, 1 / 60, BOUNDS);
    for (const v of [s.x, s.z, s.heading, s.speed, s.steer]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("tuning presets", () => {
  it("default tuning is unchanged: flat-out tops out at the lot cap", () => {
    let s: DriveState = { x: 0, z: 0, heading: 0, speed: 0, steer: 0 };
    for (let i = 0; i < 600; i++) s = step(s, { throttle: 1, steer: 0 }, 1 / 60, { x: 1e9, z: 1e9 });
    expect(s.speed).toBeCloseTo(DRIVE.MAX_FWD, 1);
  });

  it("HIGHWAY_DRIVE reaches highway speed with the same model", () => {
    let s: DriveState = { x: 0, z: 0, heading: 0, speed: 0, steer: 0 };
    for (let i = 0; i < 600; i++) s = step(s, { throttle: 1, steer: 0 }, 1 / 60, { x: 1e9, z: 1e9 }, HIGHWAY_DRIVE);
    expect(s.speed).toBeCloseTo(HIGHWAY_DRIVE.MAX_FWD, 1);
    expect(HIGHWAY_DRIVE.MAX_FWD).toBeGreaterThan(3 * DRIVE.MAX_FWD);
  });

  it("highway steering authority at top speed holds the tightest drivable line", () => {
    // binding constraint = the innermost lane edge (r = R − (EDGE − WALL_PAD)), not the centerline:
    // a retune that passes at R=180 could still make the inner carriageway unholdable flat out.
    // No extra margin factor — the real safety valve is the speed-sensitive authority curve
    // (shedding speed restores steer authority fast).
    const rMin = TRACK.R - (TRACK.EDGE - TRACK.WALL_PAD);
    const needed = Math.atan(HIGHWAY_DRIVE.WHEELBASE / rMin);
    expect(HIGHWAY_DRIVE.MAX_STEER_HIGH).toBeGreaterThan(needed);
  });
});
