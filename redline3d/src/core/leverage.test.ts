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

  it("tToLev/levFrac top out at the passed rmax (Cybertruck base / Turbo upgrade)", () => {
    expect(tToLev(100, 1500)).toBeCloseTo(1500, 6); // Cybertruck's 1500 base
    expect(tToLev(100, 3000)).toBeCloseTo(3000, 6);
    expect(tToLev(0, 1500)).toBeCloseTo(10, 6);     // RMIN floor unchanged
    expect(levFrac(1500, 1500)).toBeCloseTo(1, 6);
    expect(levFrac(10, 1500)).toBeCloseTo(0, 6);
  });

  it("the leverage stack peaks at 3000 (1500 base × 2× nitro)", () => {
    const NITRO = 2; // Orion / Cybertruck Nitro Overdrive multiplier
    expect(niceLev(tToLev(100, 1500)) * NITRO).toBe(3000); // Cybertruck (1500) + nitro
    expect(niceLev(tToLev(100, 1000)) * NITRO).toBe(2000); // default base (1000) + nitro
    expect(niceLev(tToLev(100, 1500))).toBe(1500);         // Cybertruck, no nitro
  });
});
