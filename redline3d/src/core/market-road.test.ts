import { describe, expect, it } from "vitest";
import { terrainBias } from "./market-road";

describe("terrainBias", () => {
  it("climbs on positive momentum and descends on negative momentum", () => {
    expect(terrainBias({ smoothPrice: 100, emaPrice: 100, momentum: 1 })).toBe(5.5);
    expect(terrainBias({ smoothPrice: 100, emaPrice: 100, momentum: -1 })).toBe(-5.5);
  });

  it("keeps 45% of the existing price-displacement terrain response", () => {
    expect(terrainBias({ smoothPrice: 100.1, emaPrice: 100, momentum: 0 })).toBeCloseTo(1.17, 8);
  });

  it("blends displacement and momentum", () => {
    expect(terrainBias({ smoothPrice: 100.1, emaPrice: 100, momentum: 0.5 })).toBeCloseTo(3.92, 8);
  });

  it("clamps the combined response to the existing world range", () => {
    expect(terrainBias({ smoothPrice: 102, emaPrice: 100, momentum: 1 })).toBe(7);
    expect(terrainBias({ smoothPrice: 98, emaPrice: 100, momentum: -1 })).toBe(-7);
  });

  it("uses momentum safely before the slow average exists", () => {
    expect(terrainBias({ smoothPrice: 0, emaPrice: 0, momentum: 0.5 })).toBe(2.75);
  });
});
