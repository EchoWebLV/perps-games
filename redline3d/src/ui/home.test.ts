// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cardSlug, createHome, groupByTier } from "./home";

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
    expect(groups.map((g) => g.rarity)).toEqual([5, 2, 1]);
    expect(groups[0].cars.map((c) => c.name)).toEqual(["C", "B", "E"]);
    expect(groups[1].cars.map((c) => c.name)).toEqual(["A"]);
    expect(groups[2].cars.map((c) => c.name)).toEqual(["D"]);
  });

  it("treats a missing rarity as tier 1 (common)", () => {
    const defs = [{ name: "X" }, { name: "Y", rarity: 1 }] as any[];
    const groups = groupByTier(defs, () => false);
    expect(groups.map((g) => g.rarity)).toEqual([1]);
    expect(groups[0].cars.map((c) => c.name)).toEqual(["X", "Y"]);
  });

  it("does not mutate the caller's defs array", () => {
    const defs = [{ name: "B", rarity: 5 }, { name: "A", rarity: 5 }] as any[];
    const before = defs.map((d) => d.name);
    groupByTier(defs, () => false);
    expect(defs.map((d) => d.name)).toEqual(before);
  });
});

describe("slopwheels hub", () => {
  const stub = () => ({
    onRace: vi.fn(),
    onCars: vi.fn(),
    onCrates: vi.fn(),
    onUpgrades: vi.fn(),
    onLobby: vi.fn(),
    onConnectWallet: vi.fn(),
  });

  it("is a button hub with Race / Cars / Crates / Upgrades / Lobby — no collection or Grand Prix", () => {
    const parent = document.createElement("div");
    const deps = stub();
    const home = createHome(parent, deps);
    home.show();

    const labels = [...parent.querySelectorAll("[data-hub]")].map((el) => el.textContent);
    expect(labels).toEqual(["Race", "Cars", "Crates", "Upgrades", "Lobby"]);
    expect(parent.querySelector(".sw-grid")).toBeNull();
    expect(parent.textContent).not.toMatch(/Watch & bet|Enter race|Collection|Grand Prix/i);
    expect(parent.querySelector(".sw-wordmark")?.getAttribute("alt")).toBe("Slopwheels");
  });

  it("routes each hub button to its destination", () => {
    const parent = document.createElement("div");
    const deps = stub();
    const home = createHome(parent, deps);
    home.show();

    (parent.querySelector('[data-hub="race"]') as HTMLButtonElement).click();
    (parent.querySelector('[data-hub="cars"]') as HTMLButtonElement).click();
    (parent.querySelector('[data-hub="crates"]') as HTMLButtonElement).click();
    (parent.querySelector('[data-hub="upgrades"]') as HTMLButtonElement).click();
    (parent.querySelector('[data-hub="lobby"]') as HTMLButtonElement).click();

    expect(deps.onRace).toHaveBeenCalledOnce();
    expect(deps.onCars).toHaveBeenCalledOnce();
    expect(deps.onCrates).toHaveBeenCalledOnce();
    expect(deps.onUpgrades).toHaveBeenCalledOnce();
    expect(deps.onLobby).toHaveBeenCalledOnce();
  });

  it("shows a building-track busy state on the Race button", () => {
    const parent = document.createElement("div");
    const home = createHome(parent, stub());
    home.show();
    home.setBusy(true);
    const race = parent.querySelector('[data-hub="race"]') as HTMLButtonElement;
    expect(race.disabled).toBe(true);
    expect(race.textContent).toMatch(/building/i);
    home.setBusy(false);
    expect(race.disabled).toBe(false);
    expect(race.textContent).toBe("Race");
  });
});
