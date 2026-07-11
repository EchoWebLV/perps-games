import { describe, expect, it } from "vitest";
import {
  highwayPose,
  seedHighwayMotion,
  snapHighwayLeverage,
  speedForLeverage,
  stepHighwayMotion,
} from "./highway-auto";

describe("automatic Highway motion", () => {
  it("snaps and clamps the 10x to 250x slider", () => {
    expect(snapHighwayLeverage(4)).toBe(10);
    expect(snapHighwayLeverage(146)).toBe(150);
    expect(snapHighwayLeverage(999)).toBe(250);
  });

  it("makes 250x faster than 10x", () => {
    expect(speedForLeverage(250)).toBeGreaterThan(speedForLeverage(10));
  });

  it("moves long and short in opposite arc-length directions", () => {
    const longStart = seedHighwayMotion("wallet", 1);
    const shortStart = seedHighwayMotion("wallet", -1);
    const long = stepHighwayMotion(longStart, 100, 1);
    const short = stepHighwayMotion(shortStart, 100, 1);
    expect(long.s).toBeGreaterThan(longStart.s);
    expect(short.s).toBeLessThan(shortStart.s);
  });

  it("puts longs and shorts on opposite carriageways facing their travel direction", () => {
    const long = highwayPose(seedHighwayMotion("same", 1));
    const short = highwayPose(seedHighwayMotion("same", -1));
    expect(long.x).not.toBe(short.x);
    expect(Math.abs(long.heading - short.heading)).toBeCloseTo(Math.PI, 8);
  });
});
