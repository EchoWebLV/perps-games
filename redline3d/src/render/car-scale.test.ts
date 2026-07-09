import { describe, it, expect } from "vitest";
import { carNormScale, REF_LEN, MASS_TARGET, MASS_EXP, CORR_MIN, CORR_MAX } from "./car-scale";

// Expected returns are the exact outputs of the documented formula (verified against an
// independent reference impl); the spec's "≈" values match these to within its own
// intermediate rounding. toBeCloseTo tolerances stay in the spec's 3–4 digit band.
describe("carNormScale", () => {
  it("exposes the calibration constants the sizing sites are tuned against", () => {
    expect(REF_LEN).toBeCloseTo(11.23, 6);
    expect(MASS_TARGET).toBeCloseTo(6.9, 6);
    expect(MASS_EXP).toBeCloseTo(0.5, 6);
    expect(CORR_MIN).toBeCloseTo(0.8, 6);
    expect(CORR_MAX).toBeCloseTo(1.15, 6);
  });

  it("shrinks a boxy 'slot machine' toward the median (partial volume correction)", () => {
    // {10,9,12}: length-normalized mass ≈9.60 towers over the 6.9 median → corr ≈0.848
    const s = carNormScale({ x: 10, y: 9, z: 12 }, 11.23, 1);
    expect(s).toBeCloseTo(0.793329, 4); // spec ≈0.79327
    expect(11.23 * (s / (11.23 / 12))).toBeCloseTo(9.5199, 3); // resulting length shrunk ~15%
  });

  it("grows a flat 'sports car' toward the median", () => {
    // {2,1.4,4.6}: mass ≈5.72 sits under the median → corr ≈1.098 (grows it)
    const s = carNormScale({ x: 2.0, y: 1.4, z: 4.6 }, 11.23, 1);
    expect(s).toBeCloseTo(2.680708, 4); // spec ≈2.68072
    expect(s).toBeGreaterThan(11.23 / 4.6); // above its legacy length-normalized scale
  });

  it("clamps the correction at CORR_MAX for a low-mass pancake, mul preserved", () => {
    // {9,2,12} mul 0.75: raw corr ≈1.28 would over-grow it → clamped to 1.15
    const s = carNormScale({ x: 9, y: 2, z: 12 }, 11.23, 0.75);
    expect(s).toBeCloseTo(0.807156, 4); // spec ≈0.80716
    const sLen = (11.23 / 12) * 0.75; // legacy scalar including the intent mul
    expect(s / sLen).toBeCloseTo(CORR_MAX, 6); // correction pinned to the ceiling
  });

  it("clamps the correction at CORR_MIN for a mass far above target", () => {
    // a 12³ cube reads at length-mass 11.23 » 6.9 → raw corr ≈0.784, floored to 0.8
    const s = carNormScale({ x: 12, y: 12, z: 12 }, 11.23, 1);
    const sLen = 11.23 / 12;
    expect(s / sLen).toBeCloseTo(CORR_MIN, 6);
    expect(s).toBeCloseTo(0.748667, 4);
  });

  it("leaves a median-mass car at its legacy length-normalized scale (correction ~1)", () => {
    // construct a car whose length-normalized mass is exactly MASS_TARGET → corr === 1,
    // i.e. the correction only moves outliers; a median car is untouched (legacy behaviour)
    const L = 6;
    const h = L * Math.pow(MASS_TARGET / REF_LEN, 3); // makes cbrt(L·L·h)·(REF_LEN/L) === MASS_TARGET
    const s = carNormScale({ x: L, y: h, z: L }, REF_LEN, 1);
    expect(s).toBeCloseTo(REF_LEN / L, 6); // == legacy sLen, no rescale
  });

  it("is invariant under targetLen: the ratio of two sizings equals the targetLen ratio", () => {
    // corr cancels targetLen by design (target scales with it), so an 8.6-footprint site
    // corrects identically to the 11.23 site — only the base length differs
    for (const size of [
      { x: 2, y: 1.4, z: 4.6 }, // unclamped grow
      { x: 10, y: 9, z: 12 },   // unclamped shrink
      { x: 9, y: 2, z: 12 },    // ceiling-clamped
      { x: 12, y: 12, z: 12 },  // floor-clamped
    ]) {
      const ratio = carNormScale(size, 8.6, 1.3) / carNormScale(size, 11.23, 1.3);
      expect(ratio).toBeCloseTo(8.6 / 11.23, 10);
    }
  });

  it("is monotonically increasing in mul", () => {
    const size = { x: 2, y: 1.4, z: 4.6 };
    const muls = [0.3, 0.6, 1.0, 1.5, 2.5];
    const out = muls.map((m) => carNormScale(size, 11.23, m));
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });

  it("with MASS_EXP 0.5 the correction damps mul: doubling-ish mul under-scales the result", () => {
    // near m=1 (unclamped) the car grows less than proportionally with mul — the
    // sqrt correction pulls oversized-by-mul cars back, so mul never doubles the render
    const size = { x: 2, y: 1.4, z: 4.6 };
    const base = carNormScale(size, 11.23, 1.0);
    const up = carNormScale(size, 11.23, 1.02);
    expect(up).toBeGreaterThan(base);        // still increasing
    expect(up).toBeLessThan(1.02 * base);    // but sub-linear in mul
  });

  it("returns a finite number for a degenerate zero-size model", () => {
    const s = carNormScale({ x: 0, y: 0, z: 0 }, 11.23, 1);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeCloseTo(11.23, 6); // max()||1 guards the divide; zero volume → corr 1
  });
});
