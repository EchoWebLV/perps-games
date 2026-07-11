import { describe, expect, it } from "vitest";
import { REMOTE_SNAP_DISTANCE, shortestAngleDelta, smoothRemote, type RemotePose } from "./remote-motion";

describe("smoothRemote", () => {
  it("takes the shortest path across the PI boundary", () => {
    const next = smoothRemote(
      { x: 0, z: 0, heading: Math.PI - 0.05, speed: 1 },
      { x: 0, z: 0, heading: -Math.PI + 0.05, speed: 1 },
      1 / 60,
    );

    expect(Math.abs(shortestAngleDelta(Math.PI - 0.05, next.heading))).toBeLessThan(0.05);
  });

  it("matches one 1/30 step with two 1/60 steps", () => {
    const current: RemotePose = { x: -4, z: 3, heading: -0.8, speed: 2 };
    const target: RemotePose = { x: 12, z: -8, heading: 1.2, speed: 24 };

    const oneStep = smoothRemote(current, target, 1 / 30);
    const twoSteps = smoothRemote(smoothRemote(current, target, 1 / 60), target, 1 / 60);

    expect(twoSteps.x).toBeCloseTo(oneStep.x, 10);
    expect(twoSteps.z).toBeCloseTo(oneStep.z, 10);
    expect(twoSteps.heading).toBeCloseTo(oneStep.heading, 10);
    expect(twoSteps.speed).toBeCloseTo(oneStep.speed, 10);
  });

  it("converges on the target pose", () => {
    const target: RemotePose = { x: 20, z: -10, heading: 1, speed: 8 };
    let current: RemotePose = { x: 0, z: 0, heading: -1, speed: 0 };

    for (let frame = 0; frame < 120; frame += 1) current = smoothRemote(current, target, 1 / 60);

    expect(current.x).toBeCloseTo(target.x, 6);
    expect(current.z).toBeCloseTo(target.z, 6);
    expect(current.heading).toBeCloseTo(target.heading, 6);
    expect(current.speed).toBeCloseTo(target.speed, 6);
  });

  it("snaps to a target 31 units away", () => {
    const target: RemotePose = { x: REMOTE_SNAP_DISTANCE + 1, z: 0, heading: -0.5, speed: 12 };

    expect(smoothRemote({ x: 0, z: 0, heading: 0.5, speed: 1 }, target, 1 / 60)).toEqual(target);
  });
});
