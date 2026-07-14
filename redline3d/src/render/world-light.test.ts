import { describe, expect, test } from "vitest";
import { lampWorldLightFactor } from "./world";

describe("lampWorldLightFactor", () => {
  test("dying fixture mode keeps the same world illumination as a normal lamp", () => {
    expect(lampWorldLightFactor(2, 0)).toBe(1);
    expect(lampWorldLightFactor(2, 32)).toBeCloseTo(0.25);
    expect(lampWorldLightFactor(2, 0)).toBe(lampWorldLightFactor(0, 0));
  });

  test("dead lamps stay dark and distance still fades live lamps", () => {
    expect(lampWorldLightFactor(1, 0)).toBe(0);
    expect(lampWorldLightFactor(0, 64)).toBe(0);
    expect(lampWorldLightFactor(2, 96)).toBe(0);
  });
});
