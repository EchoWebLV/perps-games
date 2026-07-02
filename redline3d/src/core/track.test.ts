import { describe, it, expect } from "vitest";
import { TRACK, LEN, sample, progress, contain, spawnPose, HW_BOUNDS, WALL_SCRAPE, elevationAt } from "./track";

const { R, STRAIGHT, MEDIAN_HALF, EDGE } = TRACK;

describe("track sample()", () => {
  it("starts on the east straight heading north (heading 0)", () => {
    const c = sample(0);
    expect(c.x).toBeCloseTo(R);
    expect(c.z).toBeCloseTo(STRAIGHT / 2);
    expect(c.heading).toBeCloseTo(0);
  });

  it("reaches the west straight heading south (heading π) after straight+arc", () => {
    const c = sample(STRAIGHT + Math.PI * R);
    expect(c.x).toBeCloseTo(-R);
    expect(c.z).toBeCloseTo(-STRAIGHT / 2);
    expect(Math.abs(c.heading)).toBeCloseTo(Math.PI);
  });

  it("is at the top of the north arc, heading west, at straight + quarter arc", () => {
    const c = sample(STRAIGHT + (Math.PI / 2) * R);
    expect(c.x).toBeCloseTo(0);
    expect(c.z).toBeCloseTo(-STRAIGHT / 2 - R);
    expect(c.heading).toBeCloseTo(-Math.PI / 2); // forward = (-1, 0) = west
  });

  it("wraps: sample(LEN) equals sample(0)", () => {
    const a = sample(0), b = sample(LEN);
    expect(b.x).toBeCloseTo(a.x);
    expect(b.z).toBeCloseTo(a.z);
  });
});

describe("track progress()", () => {
  it("projects a point right of the east straight to positive (outer) lateral", () => {
    const p = progress(R + 5, 40);
    expect(p.lateralOffset).toBeCloseTo(5);
    expect(p.s).toBeCloseTo(STRAIGHT / 2 - 40);
    expect(p.tangentHeading).toBeCloseTo(0);
  });

  it("projects a point outside the west straight to positive lateral too (outward = +)", () => {
    const p = progress(-R - 5, 0);
    expect(p.lateralOffset).toBeCloseTo(5);
    expect(p.tangentHeading).toBeCloseTo(Math.PI);
  });

  it("projects an inner-carriageway point to negative lateral", () => {
    expect(progress(R - 5, 40).lateralOffset).toBeCloseTo(-5);
  });

  it("projects arc points radially (lateral = distance from arc center − R)", () => {
    // north arc: center (0, −STRAIGHT/2); a point straight up from the center at radius R+3
    const p = progress(0, -STRAIGHT / 2 - (R + 3));
    expect(p.lateralOffset).toBeCloseTo(3);
    expect(p.s).toBeCloseTo(STRAIGHT + (Math.PI / 2) * R);
  });

  it("round-trips sample(): progress(sample(s)) recovers s with ~0 lateral", () => {
    for (const s of [10, STRAIGHT / 2, STRAIGHT + 20, STRAIGHT + Math.PI * R + 50, LEN - 5]) {
      const c = sample(s);
      const p = progress(c.x, c.z);
      expect(p.lateralOffset).toBeCloseTo(0, 5);
      expect(p.s).toBeCloseTo(s, 3);
    }
  });
});

describe("track contain()", () => {
  it("leaves a mid-carriageway point alone", () => {
    const c = contain(R + MEDIAN_HALF + 5, 40);
    expect(c.hitWall).toBe(false);
    expect(c.x).toBeCloseTo(R + MEDIAN_HALF + 5);
    expect(c.z).toBeCloseTo(40);
  });

  it("clamps a point past the outer barrier back in and reports the hit", () => {
    const c = contain(R + EDGE + 4, 40);
    expect(c.hitWall).toBe(true);
    expect(c.x).toBeLessThan(R + EDGE);
  });

  it("blocks the median: a point on the centerline is pushed back to its own side", () => {
    const c = contain(R + 0.2, 40); // barely on the outer side of the centerline
    expect(c.hitWall).toBe(true);
    expect(c.x).toBeGreaterThan(R + MEDIAN_HALF); // pushed out of the median, same side
  });

  it("contains on the arcs too (radial clamp)", () => {
    const c = contain(0, -STRAIGHT / 2 - (R + EDGE + 6));
    expect(c.hitWall).toBe(true);
    const d = Math.hypot(c.x - 0, c.z + STRAIGHT / 2);
    expect(d).toBeLessThan(R + EDGE);
  });

  it("is hitWall-stable on its own output (no float-noise re-fire)", () => {
    const c1 = contain(R + EDGE + 4, 40);
    const c2 = contain(c1.x, c1.z);
    expect(c2.hitWall).toBe(false);
  });
});

describe("TRACK constants", () => {
  it("EDGE derives from the median + LANES lanes (retuning one must retune all)", () => {
    expect(EDGE).toBe(MEDIAN_HALF + TRACK.LANES * TRACK.LANE_W);
  });

  it("wall scrape halves speed in about half a second, never zeroes it", () => {
    let v = 100;
    for (let i = 0; i < 30; i++) v *= Math.exp(-WALL_SCRAPE * (1 / 60));
    expect(v).toBeGreaterThan(45); expect(v).toBeLessThan(60);
  });
});

describe("elevationAt", () => {
  it("is periodic across the s=0 seam", () => {
    expect(elevationAt(0)).toBeCloseTo(elevationAt(LEN), 9);
    expect(elevationAt(-5)).toBeCloseTo(elevationAt(LEN - 5), 9);
  });

  it("is non-negative and bounded over the lap", () => {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i <= 2000; i++) {
      const y = elevationAt((i / 2000) * LEN);
      min = Math.min(min, y); max = Math.max(max, y);
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(12);
    expect(max - min).toBeGreaterThan(5); // it actually has hills
  });

  it("is smooth (no step bigger than a gentle grade between 1-unit samples)", () => {
    for (let i = 0; i < 2000; i++) {
      const a = elevationAt((i / 2000) * LEN), b = elevationAt(((i + 1) / 2000) * LEN);
      expect(Math.abs(b - a)).toBeLessThan(0.12); // ≤ ~10% grade at ~1.17u spacing
    }
  });
});

describe("track spawnPose()", () => {
  it("LONG spawns in the outer carriageway on the east straight, heading north", () => {
    const p = spawnPose(1);
    expect(p.x).toBeGreaterThan(R + MEDIAN_HALF);
    expect(p.x).toBeLessThan(R + EDGE);
    expect(p.heading).toBeCloseTo(0);
    expect(p.speed).toBe(0);
  });

  it("SHORT spawns in the inner carriageway heading the other way", () => {
    const p = spawnPose(-1);
    expect(p.x).toBeGreaterThan(R - EDGE);
    expect(p.x).toBeLessThan(R - MEDIAN_HALF);
    expect(Math.abs(p.heading)).toBeCloseTo(Math.PI);
  });

  it("both spawn poses survive contain() untouched", () => {
    for (const d of [1, -1] as const) {
      const p = spawnPose(d);
      expect(contain(p.x, p.z).hitWall).toBe(false);
    }
  });
});

describe("HW_BOUNDS", () => {
  it("is generous enough that freedrive's rectangular clamp never fires on the track", () => {
    expect(HW_BOUNDS.x).toBeGreaterThan(R + EDGE + 20);
    expect(HW_BOUNDS.z).toBeGreaterThan(STRAIGHT / 2 + R + EDGE + 20);
  });
});
