import { describe, expect, test } from "vitest";
import { createFireTrailCore, TRAIL_GAP, TRAIL_LIFE, TRAIL_MAX, TRAIL_TRACK } from "./firetrail";

describe("fire trail core (DeLorean flux traces)", () => {
  test("spawns nothing while inactive", () => {
    const t = createFireTrailCore();
    expect(t.update(0.5, 40, false, 0, -12)).toHaveLength(0);
    expect(t.update(0.5, 40, false, 2, -12)).toHaveLength(0);
  });

  test("active: lays flame pairs on a distance cadence at both wheel tracks", () => {
    const t = createFireTrailCore();
    // one update covering exactly 2 gaps of road travel → 2 pairs = 4 flames
    const dist = TRAIL_GAP * 2;
    const flames = t.update(dist / 40, 40, true, 1.5, -12);
    expect(flames.length).toBe(4);
    const xs = flames.map((f) => f.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(1.5 - TRAIL_TRACK / 2);
    expect(xs[3]).toBeCloseTo(1.5 + TRAIL_TRACK / 2);
  });

  test("flames scroll back with the road and expire after TRAIL_LIFE", () => {
    const t = createFireTrailCore();
    t.update(TRAIL_GAP / 40, 40, true, 0, -12);        // spawn a pair
    const before = t.update(0.2, 40, false, 0, -12);   // inactive: no new spawns, existing scroll
    expect(before.length).toBe(2);
    expect(before[0].z).toBeGreaterThan(-12);          // moved toward the camera (+z)
    const gone = t.update(TRAIL_LIFE, 40, false, 0, -12);
    expect(gone.length).toBe(0);                        // aged out
  });

  test("pool is capped: oldest flames are recycled, never more than TRAIL_MAX", () => {
    const t = createFireTrailCore();
    let flames: ReturnType<typeof t.update> = [];
    for (let i = 0; i < 200; i++) flames = t.update(TRAIL_GAP / 40, 40, true, 0, -12);
    expect(flames.length).toBeLessThanOrEqual(TRAIL_MAX);
  });

  test("age is exposed so the view can fade flames out", () => {
    const t = createFireTrailCore();
    t.update(TRAIL_GAP / 40, 40, true, 0, -12);
    const [f] = t.update(0.3, 40, false, 0, -12);
    expect(f.age).toBeGreaterThanOrEqual(0.3);
    expect(f.life).toBe(TRAIL_LIFE);
  });
});
