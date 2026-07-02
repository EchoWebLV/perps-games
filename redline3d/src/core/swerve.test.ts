import { describe, expect, test } from "vitest";
import { createSwerveCore, SWERVE_BUFFER } from "./swerve";

describe("auto-swerve core (Helmet)", () => {
  test("fires exactly once, the moment the liq buffer crosses the threshold", () => {
    const s = createSwerveCore();
    s.setEnabled(true);
    expect(s.update(true, 1)).toBe(false);              // healthy → no swerve
    expect(s.update(true, SWERVE_BUFFER + 0.01)).toBe(false); // near, not at
    expect(s.update(true, SWERVE_BUFFER)).toBe(true);   // at the edge → swerve NOW
    expect(s.update(true, SWERVE_BUFFER)).toBe(false);  // same dip → no repeat
    expect(s.update(true, 0.02)).toBe(false);           // deeper → still spent
    expect(s.update(true, 0.9)).toBe(false);            // recovered…
    expect(s.update(true, 0.05)).toBe(false);           // …second dip same round → spent
  });

  test("does not fire when the car doesn't have the ability, or when idle", () => {
    const s = createSwerveCore();
    expect(s.update(true, 0.01)).toBe(false);           // not enabled
    s.setEnabled(true);
    expect(s.update(false, 0.01)).toBe(false);          // enabled but no live round
  });

  test("re-arms for the next round", () => {
    const s = createSwerveCore();
    s.setEnabled(true);
    expect(s.update(true, 0.05)).toBe(true);            // used this round
    s.update(false, 1);                                 // round settled
    expect(s.update(true, 0.05)).toBe(true);            // fresh round → fires again
  });

  test("threshold sits at the Skull near-death altitude (10% of margin left)", () => {
    expect(SWERVE_BUFFER).toBe(0.10);
  });
});
