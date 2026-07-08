import { describe, expect, test } from "vitest";
import { createWorldFlipCore, FLIP_SECS } from "./worldflip";

describe("world flip core (Helmet: flip the level 180° and ride inverted)", () => {
  test("level until triggered — a live round alone never flips the world", () => {
    const w = createWorldFlipCore();
    expect(w.update(0.5, true)).toBe(0);
    expect(w.update(5, true)).toBe(0);
  });

  test("trigger flips to fully upside-down (π) and HOLDS while the round lives", () => {
    const w = createWorldFlipCore();
    w.update(0.1, true);
    w.trigger();
    const mid = w.update(FLIP_SECS / 2, true);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(Math.PI);
    expect(w.update(FLIP_SECS, true)).toBeCloseTo(Math.PI); // fully inverted
    expect(w.update(10, true)).toBeCloseTo(Math.PI);        // stays inverted to the settle
  });

  test("round end unwinds back to level and re-arms for the next round", () => {
    const w = createWorldFlipCore();
    w.update(0.1, true);
    w.trigger();
    w.update(FLIP_SECS + 1, true);
    const partway = w.update(FLIP_SECS / 2, false);         // settled → unwinding
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(Math.PI);
    expect(w.update(FLIP_SECS, false)).toBe(0);             // level again
    w.update(0.1, true);                                    // next round
    expect(w.trigger()).toBe(true);                         // re-armed
  });

  test("a second trigger while flipped is a no-op", () => {
    const w = createWorldFlipCore();
    w.update(0.1, true);
    expect(w.trigger()).toBe(true);
    w.update(FLIP_SECS, true);
    expect(w.trigger()).toBe(false);
    expect(w.update(0.1, true)).toBeCloseTo(Math.PI);
  });

  test("a round ending mid-flip unwinds from wherever it was", () => {
    const w = createWorldFlipCore();
    w.update(0.1, true);
    w.trigger();
    const mid = w.update(FLIP_SECS / 2, true);
    const after = w.update(0.01, false);
    expect(after).toBeLessThanOrEqual(mid);
    expect(w.update(FLIP_SECS, false)).toBe(0);
  });
});
