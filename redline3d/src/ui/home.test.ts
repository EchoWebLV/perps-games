import { describe, expect, it } from "vitest";
import { cardSlug, groupByTier } from "./home";

describe("home helpers", () => {
  it("slugs display names the same way bake-cards does", () => {
    expect(cardSlug("Pink Rod")).toBe("pink-rod");
    expect(cardSlug("Slot Machine")).toBe("slot-machine");
    expect(cardSlug("Cybertruck")).toBe("cybertruck");
  });

  it("groups by rarity tier, 5★ first, owned-then-name within a tier", () => {
    const defs = [
      { name: "A", rarity: 2 },
      { name: "B", rarity: 5 },
      { name: "C", rarity: 5 },
      { name: "D", rarity: 1 },
      { name: "E", rarity: 5 },
    ] as any[];
    const owns = (n: string) => n === "C";
    const groups = groupByTier(defs, owns);
    // only tiers that actually have cars, highest rarity first
    expect(groups.map((g) => g.rarity)).toEqual([5, 2, 1]);
    // within 5★: the owned car (C) leads, then the rest alphabetically (B, E)
    expect(groups[0].cars.map((c) => c.name)).toEqual(["C", "B", "E"]);
    expect(groups[1].cars.map((c) => c.name)).toEqual(["A"]);
    expect(groups[2].cars.map((c) => c.name)).toEqual(["D"]);
  });

  it("treats a missing rarity as tier 1 (common)", () => {
    const defs = [{ name: "X" }, { name: "Y", rarity: 1 }] as any[];
    const groups = groupByTier(defs, () => false);
    expect(groups.map((g) => g.rarity)).toEqual([1]);
    // both land in tier 1; neither owned → pure name order
    expect(groups[0].cars.map((c) => c.name)).toEqual(["X", "Y"]);
  });

  it("does not mutate the caller's defs array", () => {
    const defs = [{ name: "B", rarity: 5 }, { name: "A", rarity: 5 }] as any[];
    const before = defs.map((d) => d.name);
    groupByTier(defs, () => false);
    expect(defs.map((d) => d.name)).toEqual(before);
  });
});
