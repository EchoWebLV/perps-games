// @vitest-environment jsdom
import { describe, expect, test, it, beforeEach } from "vitest";
import { upgradeCost, trackValue, MAX_LEVEL, createUpgrades } from "./upgrades";
import { CONFIG } from "../core/config";

describe("upgrade tree math", () => {
  test("cost escalates per level", () => {
    expect(upgradeCost(0)).toBe(20);
    expect(upgradeCost(1)).toBe(40);
    expect(upgradeCost(9)).toBe(200); // level 9 → 10 (the last)
  });

  test("Turbo: +50× leverage per level", () => {
    expect(trackValue(1000, 50, 0)).toBe(1000);
    expect(trackValue(1000, 50, 1)).toBe(1050);
    expect(trackValue(1000, 50, MAX_LEVEL)).toBe(1500);
  });

  test("Tank: +6s round time per level", () => {
    expect(trackValue(60, 6, 0)).toBe(60);
    expect(trackValue(60, 6, MAX_LEVEL)).toBe(120);
  });

  test("Suspension: -1pp liquidation floor per level", () => {
    expect(trackValue(0.2, -0.01, 0)).toBeCloseTo(0.2, 6);
    expect(trackValue(0.2, -0.01, MAX_LEVEL)).toBeCloseTo(0.1, 6);
  });
});

describe("scrap sink + finishes", () => {
  beforeEach(() => localStorage.clear());

  function make() {
    const root = document.createElement("div");
    return createUpgrades(root, {});
  }

  test("spendScrap debits when affordable and no-ops when not", () => {
    const u = make();
    u.addScrap(100);
    expect(u.spendScrap(30)).toBe(true);
    expect(u.scrap()).toBe(70);
    expect(u.spendScrap(9999)).toBe(false); // can't cover -> no-op
    expect(u.scrap()).toBe(70);
  });

  test("finishes persist per car across reloads", () => {
    const a = make();
    a.setFinish("Orion", "gold");
    expect(a.finish("Orion")).toBe("gold");
    const b = make(); // fresh instance reads the same localStorage
    expect(b.finish("Orion")).toBe("gold");
    expect(b.finish("Helmet")).toBeUndefined();
  });

  it("fires onMutate for earns and spends, and hydrate overwrites without firing", () => {
    const root = document.createElement("div");
    const events: { kind: string; amount?: number }[] = [];
    const up = createUpgrades(root, { onMutate: (e) => events.push(e) });

    up.addCoins(40);
    up.addScrap(6);
    expect(events).toEqual([{ kind: "coinsEarn", amount: 40 }, { kind: "scrapEarn", amount: 6 }]);

    expect(up.spend(15)).toBe(true);
    expect(events[events.length - 1]).toEqual({ kind: "coinsSpend", amount: 15 });

    expect(up.spend(9999)).toBe(false); // can't afford → no event
    expect(events.filter((e) => e.kind === "coinsSpend").length).toBe(1);

    // hydrate = accept server truth; it must NOT echo back as a mutation
    const before = events.length;
    up.hydrate({ coins: 500, scrap: 20 });
    expect(up.coins()).toBe(500);
    expect(up.scrap()).toBe(20);
    expect(events.length).toBe(before);
  });
});

describe("upgrade levels sync (server-authoritative buys)", () => {
  beforeEach(() => localStorage.clear());

  it("buy reports levelBought with track+cost — NOT coinsSpend (the server buy debits itself)", () => {
    const root = document.createElement("div");
    const events: { kind: string }[] = [];
    const up = createUpgrades(root, { onMutate: (e) => events.push(e) });
    up.addCoins(100);
    events.length = 0; // drop the earn event

    (root.querySelector('[data-buy="turbo"]') as HTMLButtonElement).click();
    expect(up.coins()).toBe(80); // optimistic local debit stays (cost 20 at level 0)
    expect(up.levels()).toEqual({ turbo: 1, tank: 0, suspension: 0 });
    expect(events).toEqual([{ kind: "levelBought", track: "turbo", cost: 20 }]);
    expect(events.some((e) => e.kind === "coinsSpend")).toBe(false); // no double debit
  });

  it("levels() returns a copy — mutating it never touches the save", () => {
    const root = document.createElement("div");
    const up = createUpgrades(root, {});
    const l = up.levels();
    l.turbo = 9;
    expect(up.levels().turbo).toBe(0);
  });

  it("hydrate applies server levels (up OR down), rewrites CONFIG, fires onApply, no onMutate", () => {
    const root = document.createElement("div");
    const events: { kind: string }[] = [];
    let applies = 0;
    const up = createUpgrades(root, { economicEffects: true, onApply: () => applies++, onMutate: (e) => events.push(e) });
    const base = applies; // createUpgrades calls apply() once at construction

    up.hydrate({ coins: 500, scrap: 0, levels: { turbo: 10, tank: 2, suspension: 1 } });
    expect(up.levels()).toEqual({ turbo: 10, tank: 2, suspension: 1 });
    expect(CONFIG.RMAX).toBe(1500);  // 1000 + 50×10 — the tach/effRmax read this live
    expect(CONFIG.MAXSEC).toBe(72);  // 60 + 6×2
    expect(applies).toBe(base + 1);  // gauge rebuild hook fired
    expect(events.length).toBe(0);   // server truth must not echo back as a mutation

    // server wins DOWNWARD too (e.g. the authoritative buy failed and reconciles lower)
    up.hydrate({ coins: 500, scrap: 0, levels: { turbo: 0, tank: 0, suspension: 0 } });
    expect(up.levels()).toEqual({ turbo: 0, tank: 0, suspension: 0 });
    expect(CONFIG.RMAX).toBe(1000);  // restored to base (also un-dirties the mutable CONFIG for other tests)
    expect(CONFIG.MAXSEC).toBe(60);
  });

  it("hydrate WITHOUT levels (old server) preserves local levels", () => {
    const root = document.createElement("div");
    const up = createUpgrades(root, {});
    up.addCoins(100);
    (root.querySelector('[data-buy="tank"]') as HTMLButtonElement).click();
    expect(up.levels().tank).toBe(1);

    up.hydrate({ coins: 500, scrap: 20 }); // no levels field → don't zero the local tree
    expect(up.levels()).toEqual({ turbo: 0, tank: 1, suspension: 0 });
    expect(up.coins()).toBe(500);
  });
});
