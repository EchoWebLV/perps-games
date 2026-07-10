import { describe, expect, it } from "vitest";
import { roadGradeOffset, roadGradeSlope, terrainGrade } from "./market-road";

describe("terrainGrade", () => {
  it("climbs on positive momentum and descends on negative momentum", () => {
    expect(terrainGrade({ smoothPrice: 100, emaPrice: 100, momentum: 1 })).toBe(8);
    expect(terrainGrade({ smoothPrice: 100, emaPrice: 100, momentum: -1 })).toBe(-8);
  });

  it("keeps half of the existing price-displacement terrain response", () => {
    expect(terrainGrade({ smoothPrice: 100.1, emaPrice: 100, momentum: 0 })).toBeCloseTo(1.3, 8);
  });

  it("blends displacement and momentum", () => {
    expect(terrainGrade({ smoothPrice: 100.1, emaPrice: 100, momentum: 0.5 })).toBeCloseTo(5.3, 8);
  });

  it("clamps the combined response to an eight-degree grade", () => {
    expect(terrainGrade({ smoothPrice: 102, emaPrice: 100, momentum: 1 })).toBe(8);
    expect(terrainGrade({ smoothPrice: 98, emaPrice: 100, momentum: -1 })).toBe(-8);
  });

  it("uses momentum safely before the slow average exists", () => {
    expect(terrainGrade({ smoothPrice: 0, emaPrice: 0, momentum: 0.5 })).toBe(4);
  });
});

describe("road grade geometry", () => {
  it("anchors the grade at the car and tilts the road ahead instead of lifting it", () => {
    const slope = roadGradeSlope(8);

    expect(roadGradeOffset(-12, slope)).toBe(0);
    expect(roadGradeOffset(-112, slope)).toBeCloseTo(14.05, 2);
    expect(roadGradeOffset(88, slope)).toBeCloseTo(-14.05, 2);
  });

  it("reverses the tilt for negative momentum", () => {
    const slope = roadGradeSlope(-8);

    expect(roadGradeOffset(-112, slope)).toBeLessThan(0);
  });
});
