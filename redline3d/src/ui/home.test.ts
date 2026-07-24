import { describe, expect, it } from "vitest";
import { cardSlug, sortForCollection } from "./home";

describe("home helpers", () => {
  it("slugs display names the same way bake-cards does", () => {
    expect(cardSlug("Pink Rod")).toBe("pink-rod");
    expect(cardSlug("Slot Machine")).toBe("slot-machine");
    expect(cardSlug("Cybertruck")).toBe("cybertruck");
  });
  it("sorts owned first, then by rarity desc, then name", () => {
    const defs = [
      { name: "A", rarity: 2 }, { name: "B", rarity: 5 }, { name: "C", rarity: 5 }, { name: "D", rarity: 1 },
    ] as any[];
    const owns = (n: string) => n === "C" || n === "D";
    expect(sortForCollection(defs, owns).map((d) => d.name)).toEqual(["C", "D", "B", "A"]);
  });
});
