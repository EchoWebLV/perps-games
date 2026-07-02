import { describe, it, expect } from "vitest";
import { GEARS, HW_MAX_LEV, shiftGear, levOf } from "./highway-gears";

describe("gear ladder", () => {
  it("spans the program floor (10×) to the mode cap (100×), monotonic", () => {
    expect(GEARS[0]).toBe(10);
    expect(GEARS[GEARS.length - 1]).toBe(100);
    expect(HW_MAX_LEV).toBe(100);
    for (let i = 1; i < GEARS.length; i++) expect(GEARS[i]).toBeGreaterThan(GEARS[i - 1]);
  });

  it("levOf clamps out-of-range gears", () => {
    expect(levOf(-1)).toBe(10);
    expect(levOf(999)).toBe(100);
  });
});

describe("shiftGear", () => {
  const N = GEARS.length;

  it("stopped car sits in gear 0 (10×)", () => {
    expect(shiftGear(0, 0)).toBe(0);
    expect(levOf(shiftGear(0, 0))).toBe(10);
  });

  it("flat out reaches top gear (100×)", () => {
    expect(shiftGear(0, 1)).toBe(N - 1);
    expect(levOf(N - 1)).toBe(100);
  });

  it("upshifts only past the boundary + hysteresis", () => {
    const boundary = 1 / N;
    expect(shiftGear(0, boundary + 0.001)).toBe(0);  // inside the dead band → hold
    expect(shiftGear(0, boundary + 0.05)).toBe(1);   // clearly past → shift
  });

  it("does not flicker across a boundary (hysteresis)", () => {
    const boundary = 2 / N;
    let g = shiftGear(0, boundary + 0.05); // → gear 2
    expect(g).toBe(2);
    g = shiftGear(g, boundary - 0.01); // small dip back below the raw boundary → hold
    expect(g).toBe(2);
    g = shiftGear(g, boundary - 0.05); // clearly below → downshift
    expect(g).toBe(1);
  });

  it("jumps multiple gears in one call when speed changes a lot", () => {
    expect(shiftGear(0, 0.99)).toBe(N - 1);
    expect(shiftGear(N - 1, 0)).toBe(0);
  });

  it("clamps a malformed current gear", () => {
    expect(shiftGear(-3, 0)).toBe(0);
    expect(shiftGear(99, 1)).toBe(N - 1);
  });
});
