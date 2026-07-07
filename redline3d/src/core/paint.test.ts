import { describe, test, expect } from "vitest";
import { FINISHES, finishById, paintPrice } from "./paint";

describe("paint catalog", () => {
  test("Golden Paint exists and resolves by id", () => {
    expect(finishById("gold")?.name).toBe("Golden Paint");
    expect(finishById("nope")).toBeUndefined();
    expect(FINISHES.length).toBeGreaterThanOrEqual(2);
  });

  test("price scales with rarity; gold is the premium finish", () => {
    expect(paintPrice(1, "cyan")).toBeLessThan(paintPrice(5, "cyan"));
    expect(paintPrice(3, "gold")).toBeGreaterThan(paintPrice(3, "cyan"));
    expect(paintPrice(undefined, "cyan")).toBe(paintPrice(1, "cyan")); // defaults to Common
  });
});
