import { describe, it, expect } from "vitest";
import { step, DRIVE, type DriveState } from "./freedrive";

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
    expect(half.steer / full.steer).toBeLessThan(0.45); // 0.5^1.8 ≈ 0.287
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
