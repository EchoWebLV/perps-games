// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { CarOption } from "./carpicker";
import { cardSlug, createHome, groupByTier, pickDriveStripCar } from "./home";

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

describe("pickDriveStripCar", () => {
  const defs = [
    { name: "Orion", rarity: 5 },
    { name: "Bedrock", rarity: 5 },
    { name: "Cybertruck", rarity: 3 },
    { name: "Solana Paper", rarity: 1 },
    { name: "Skull", rarity: 5, comingSoon: true },
  ] as CarOption[];
  const ownsOnly = (...names: string[]) => (n: string) => names.includes(n);

  it("prefers the equipped car when it is owned and drivable", () => {
    expect(pickDriveStripCar(defs, ownsOnly("Cybertruck", "Solana Paper"), "Cybertruck")).toBe("Cybertruck");
  });

  it("falls to the highest-rarity owned car (A–Z tie-break) when the equipped car isn't owned", () => {
    // boot may equip an unowned hero (e.g. localhost DEV_UNLOCK), so equipped 'Cybertruck' isn't owned
    // here; among the two owned 5★ cars the alphabetical tie-break picks Bedrock over Orion
    expect(pickDriveStripCar(defs, ownsOnly("Bedrock", "Orion", "Solana Paper"), "Cybertruck")).toBe("Bedrock");
  });

  it("excludes comingSoon cars from the candidate pool", () => {
    // owns a comingSoon 5★ (Skull) + a common — Skull can't be equipped, so Solana Paper wins
    expect(pickDriveStripCar(defs, ownsOnly("Skull", "Solana Paper"), "Skull")).toBe("Solana Paper");
  });

  it("returns null when no drivable car is owned", () => {
    expect(pickDriveStripCar(defs, ownsOnly(), "Orion")).toBeNull();
    expect(pickDriveStripCar(defs, ownsOnly("Skull"), "Skull")).toBeNull(); // only a comingSoon car
  });
});

describe("home footer dual CTA", () => {
  const defs = [
    { name: "Orion", rarity: 5, url: "/m/o.glb" },
    { name: "Solana Paper", rarity: 1, url: "/m/s.glb" },
  ] as CarOption[];
  const makeDeps = (owned: string[]) => {
    const set = new Set(owned);
    return {
      cars: () => defs,
      owns: (n: string) => set.has(n),
      equippedName: () => "Solana Paper",
      onDriveLobby: vi.fn(),
      onDriveStrip: vi.fn(),
      onEnterRace: vi.fn(),
      onWatchAndBet: vi.fn(),
      onOpenStore: vi.fn(),
    };
  };

  it("renders BOTH footer buttons (Drive the strip primary + Watch & bet)", () => {
    const home = createHome(document.createElement("div"), makeDeps(["Solana Paper"]));
    home.show();
    expect(home.el.querySelector(".sw-cta-drive")?.textContent).toBe("Drive the strip");
    expect(home.el.querySelector(".sw-cta-watch")?.textContent).toBe("Watch & bet");
    home.dispose();
  });

  it("Drive the strip equips the default owned car and enters the lobby (never the store)", () => {
    const deps = makeDeps(["Solana Paper"]);
    const home = createHome(document.createElement("div"), deps);
    home.show();
    (home.el.querySelector(".sw-cta-drive") as HTMLElement).click();
    expect(deps.onDriveStrip).toHaveBeenCalledWith("Solana Paper");
    expect(deps.onOpenStore).not.toHaveBeenCalled();
    home.dispose();
  });

  it("Drive the strip opens the crate store when no drivable car is owned", () => {
    const deps = makeDeps([]); // owns nothing
    const home = createHome(document.createElement("div"), deps);
    home.show();
    (home.el.querySelector(".sw-cta-drive") as HTMLElement).click();
    expect(deps.onDriveStrip).not.toHaveBeenCalled();
    expect(deps.onOpenStore).toHaveBeenCalledTimes(1);
    home.dispose();
  });

  it("Watch & bet stays wired to onWatchAndBet", () => {
    const deps = makeDeps(["Solana Paper"]);
    const home = createHome(document.createElement("div"), deps);
    home.show();
    (home.el.querySelector(".sw-cta-watch") as HTMLElement).click();
    expect(deps.onWatchAndBet).toHaveBeenCalledTimes(1);
    home.dispose();
  });
});
