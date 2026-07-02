import { describe, it, expect } from "vitest";
import { laneStep, LANE_DRIVE, type LaneState } from "./lane-drive";

const spawn = (over: Partial<LaneState> = {}): LaneState => ({ x: 0, vx: 0, yaw: 0, steer: 0, ...over });

/** run N seconds of laneStep at a fixed dt; returns every state INCLUDING the seed */
const simulate = (
  s0: LaneState,
  target: number,
  speedFrac: number,
  dt: number,
  seconds: number,
): LaneState[] => {
  let s = s0;
  const out: LaneState[] = [s];
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    s = laneStep(s, target, speedFrac, dt);
    out.push(s);
  }
  return out;
};

/** first time after which |x−target|<0.3 AND |vx|<0.5 hold for the REST of the window */
const settleTime = (states: LaneState[], target: number, dt: number): number => {
  let last = -1; // last index that violates the settled condition
  for (let i = 0; i < states.length; i++) {
    if (Math.abs(states[i].x - target) >= 0.3 || Math.abs(states[i].vx) >= 0.5) last = i;
  }
  return last + 1 < states.length ? (last + 1) * dt : Infinity;
};

describe("laneStep (1-D lateral car dynamics for the scrolling road)", () => {
  it("full-width swerve at speed settles in ~a second", () => {
    const traj = simulate(spawn({ x: -10 }), 10, 1, 1 / 60, 6);
    const t = settleTime(traj, 10, 1 / 60);
    expect(t).toBeGreaterThan(0.5);  // not a teleport — the car has to travel
    expect(t).toBeLessThan(1.4);     // but it's a swerve, not a commute
  });

  it("interior-target swerve overshoots by a whisper at most (juice, not float)", () => {
    // target +10 IS the wall, so overshoot is invisible there — measure at an interior lane
    const traj = simulate(spawn({ x: -10 }), 5, 1, 1 / 60, 6);
    const overshoot = Math.max(...traj.map((s) => s.x)) - 5;
    expect(overshoot).toBeLessThanOrEqual(1.0); // ≤ ~10% of the travel past the target
    expect(settleTime(traj, 5, 1 / 60)).toBeLessThan(1.4); // still docks like the full swerve
  });

  it("a slow road makes the same swerve clearly lazier (speed-scaled authority)", () => {
    const fast = settleTime(simulate(spawn({ x: -10 }), 10, 1, 1 / 60, 8), 10, 1 / 60);
    const slow = settleTime(simulate(spawn({ x: -10 }), 10, 0.25, 1 / 60, 8), 10, 1 / 60);
    expect(slow).toBeGreaterThanOrEqual(fast * 1.5);
    expect(slow).toBeLessThan(8); // still settles inside the window — lazy, not stuck
  });

  it("the parked showroom car still re-centres within a few seconds", () => {
    const traj = simulate(spawn({ x: 6 }), 0, 0, 1 / 60, 6);
    expect(settleTime(traj, 0, 1 / 60)).toBeLessThan(4);
  });

  it("dt-invariance: 60 Hz and 120 Hz trajectories agree (the core bug fix)", () => {
    const t60 = simulate(spawn({ x: -10 }), 10, 1, 1 / 60, 3);
    const t120 = simulate(spawn({ x: -10 }), 10, 1, 1 / 120, 3);
    let maxDiv = 0;
    for (let i = 0; i < t60.length; i++) {
      maxDiv = Math.max(maxDiv, Math.abs(t60[i].x - t120[2 * i].x)); // same wall-clock instant
    }
    expect(maxDiv).toBeLessThan(0.5); // Euler+exp can't be exact — but no felt difference
    expect(Math.abs(t60[t60.length - 1].x - t120[t120.length - 1].x)).toBeLessThan(0.1);
  });

  it("yaw follows actual lateral velocity and never exceeds the cap", () => {
    const traj = simulate(spawn({ x: -10 }), 10, 1, 1 / 60, 4);
    for (const s of traj) expect(Math.abs(s.yaw)).toBeLessThanOrEqual(LANE_DRIVE.YAW_MAX + 1e-9);
    // at peak lateral velocity the car is visibly leaned into the move, same sign as vx
    const peak = traj.reduce((a, b) => (Math.abs(b.vx) > Math.abs(a.vx) ? b : a));
    expect(peak.vx).toBeGreaterThan(0);
    expect(peak.yaw).toBeGreaterThan(0.05);
  });

  it("yaw eases back to ~0 once the swerve settles", () => {
    const traj = simulate(spawn({ x: -10 }), 10, 1, 1 / 60, 4);
    expect(Math.abs(traj[traj.length - 1].yaw)).toBeLessThan(0.02);
  });

  it("steer stays in [−1,1], points into the swerve, then flips to arrest it", () => {
    const traj = simulate(spawn({ x: -10 }), 10, 1, 1 / 60, 4);
    for (const s of traj) {
      expect(s.steer).toBeGreaterThanOrEqual(-1);
      expect(s.steer).toBeLessThanOrEqual(1);
    }
    expect(traj[1].steer).toBeGreaterThan(0); // initiating a rightward swerve → wheels right
    // arrest phase: still moving right (vx>0.5) but the wheels counter-steer to brake the slide
    expect(traj.some((s) => s.vx > 0.5 && s.steer < -0.1)).toBe(true);
  });

  it("ramming the wall pins x at X_MAX with vx zeroed — and it is not sticky", () => {
    // momentum straight into the wall (target clamps to X_MAX too)
    const traj = simulate(spawn({ x: 9, vx: 12 }), 1e9, 1, 1 / 60, 1);
    const pinned = traj.find((s) => s.x === LANE_DRIVE.X_MAX);
    expect(pinned).toBeDefined();
    expect(pinned!.vx).toBe(0); // outward velocity died at the wall
    for (const s of traj) expect(s.x).toBeLessThanOrEqual(LANE_DRIVE.X_MAX); // never through it
    // an inward target releases IMMEDIATELY — no sticky wall
    const s1 = laneStep(traj[traj.length - 1], 0, 1, 1 / 60);
    expect(s1.vx).toBeLessThan(0);
    expect(s1.x).toBeLessThan(LANE_DRIVE.X_MAX);
  });

  it("target beyond the road clamps: the car never leaves ±X_MAX", () => {
    for (const target of [1e9, -1e9]) {
      const traj = simulate(spawn(), target, 1, 1 / 60, 5);
      for (const s of traj) expect(Math.abs(s.x)).toBeLessThanOrEqual(LANE_DRIVE.X_MAX);
    }
  });

  it("NaN/Infinity inputs cannot poison the state", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      let a = spawn({ x: 3, vx: 2 });
      let b = spawn({ x: 3, vx: 2 });
      let c = spawn({ x: 3, vx: 2 });
      for (let i = 0; i < 10; i++) {
        a = laneStep(a, bad, 1, 1 / 60);   // poisoned target
        b = laneStep(b, 5, bad, 1 / 60);   // poisoned speedFrac
        c = laneStep(c, 5, 1, bad);        // poisoned dt
      }
      for (const s of [a, b, c]) {
        for (const v of [s.x, s.vx, s.yaw, s.steer]) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("is pure: the input state is never mutated", () => {
    const s0 = spawn({ x: -5, vx: 1, yaw: 0.1, steer: 0.2 });
    const frozen = { ...s0 };
    const s1 = laneStep(s0, 8, 1, 1 / 60);
    expect(s0).toEqual(frozen);
    expect(s1).not.toBe(s0);
  });
});
