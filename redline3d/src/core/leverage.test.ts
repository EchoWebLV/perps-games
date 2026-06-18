import { describe, it, expect } from "vitest";
import { levFrac, tToLev, niceLev } from "./leverage";

describe("leverage", () => {
  it("levFrac maps RMIN→0, RMAX→1", () => {
    expect(levFrac(10)).toBeCloseTo(0, 6);
    expect(levFrac(1000)).toBeCloseTo(1, 6);
    expect(levFrac(400)).toBeCloseTo(0.8011, 3);
  });

  it("tToLev maps throttle 0→10, 100→1000", () => {
    expect(tToLev(0)).toBeCloseTo(10, 6);
    expect(tToLev(100)).toBeCloseTo(1000, 6);
    expect(tToLev(34)).toBeCloseTo(47.867, 2);
  });

  it("niceLev rounds by band", () => {
    expect(niceLev(47.867)).toBe(50);   // <100 → nearest 5
    expect(niceLev(123)).toBe(120);     // <500 → nearest 10
    expect(niceLev(777)).toBe(800);     // >=500 → nearest 50
    expect(niceLev(1000)).toBe(1000);
  });
});
