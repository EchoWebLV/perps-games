import { describe, expect, test } from "vitest";
import { createInventory } from "./inventory";

const KEY = "redline.owned.v1";

// a tiny in-memory Storage so tests never touch real localStorage
const memStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as Storage;
};

describe("createInventory — persistent ownership (cars or levels)", () => {
  test("free items are owned; everything else is not", () => {
    const inv = createInventory(KEY, ["Starter"], memStorage());
    expect(inv.owns("Starter")).toBe(true);
    expect(inv.owns("Clown Car")).toBe(false);
  });

  test("grant returns true for a NEW item, false for a duplicate", () => {
    const inv = createInventory(KEY, ["Starter"], memStorage());
    expect(inv.grant("Clown Car")).toBe(true);   // new
    expect(inv.owns("Clown Car")).toBe(true);
    expect(inv.grant("Clown Car")).toBe(false);  // dupe
    expect(inv.grant("Starter")).toBe(false);    // free item is already owned → dupe
  });

  test("ownership persists across a reload (same storage + key)", () => {
    const store = memStorage();
    createInventory(KEY, ["Starter"], store).grant("Orion");
    const reloaded = createInventory(KEY, ["Starter"], store);
    expect(reloaded.owns("Orion")).toBe(true);
    expect(reloaded.all().sort()).toEqual(["Orion", "Starter"]);
  });

  test("free items are owned even if a stale save omits them", () => {
    const store = memStorage();
    store.setItem(KEY, JSON.stringify(["Orion"])); // save predates a new free item
    const inv = createInventory(KEY, ["Starter"], store);
    expect(inv.owns("Starter")).toBe(true);
    expect(inv.owns("Orion")).toBe(true);
  });

  test("two inventories with different keys don't collide (cars vs levels)", () => {
    const store = memStorage();
    const cars = createInventory("redline.owned.v1", ["Starter"], store);
    const levels = createInventory("redline.levels.v1", ["synthwave"], store);
    cars.grant("Orion"); levels.grant("neon-city");
    expect(cars.owns("neon-city")).toBe(false);
    expect(levels.owns("Orion")).toBe(false);
    expect(cars.all().sort()).toEqual(["Orion", "Starter"]);
    expect(levels.all().sort()).toEqual(["neon-city", "synthwave"]);
  });
});

// a throwaway in-memory Storage so tests never touch real localStorage
function memStore(seed?: string): Storage {
  const m = new Map<string, string>();
  if (seed !== undefined) m.set("k", seed);
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  } as Storage;
}

describe("counted inventory", () => {
  test("grant increments count and reports newlyOwned only on 0->1", () => {
    const inv = createInventory("k", [], memStore());
    expect(inv.grant("Orion")).toBe(true);   // newly owned
    expect(inv.count("Orion")).toBe(1);
    expect(inv.grant("Orion")).toBe(false);  // duplicate
    expect(inv.count("Orion")).toBe(2);
  });

  test("spares = count - 1; melt sheds a spare but never the last copy", () => {
    const inv = createInventory("k", [], memStore());
    inv.grant("Orion"); inv.grant("Orion"); inv.grant("Orion"); // x3
    expect(inv.spares("Orion")).toBe(2);
    expect(inv.melt("Orion")).toBe(true);   // x3 -> x2
    expect(inv.melt("Orion")).toBe(true);   // x2 -> x1
    expect(inv.melt("Orion")).toBe(false);  // floor: last copy stays
    expect(inv.count("Orion")).toBe(1);
    expect(inv.owns("Orion")).toBe(true);
  });

  test("free items floor at 1 and cannot be melted", () => {
    const inv = createInventory("k", ["Starter"], memStore());
    expect(inv.count("Starter")).toBe(1);
    expect(inv.melt("Starter")).toBe(false);
  });

  test("meltable lists only cars with spares", () => {
    const inv = createInventory("k", [], memStore());
    inv.grant("A"); inv.grant("A"); // x2 -> 1 spare
    inv.grant("B");                 // x1 -> 0 spares
    expect(inv.meltable()).toEqual([{ id: "A", count: 2 }]);
  });

  test("migrates a legacy id-array to counts of 1", () => {
    const inv = createInventory("k", ["Starter"], memStore(JSON.stringify(["Orion", "Helmet"])));
    expect(inv.count("Orion")).toBe(1);
    expect(inv.count("Helmet")).toBe(1);
    expect(inv.owns("Starter")).toBe(true);
  });

  test("round-trips counts through storage as an object map", () => {
    const store = memStore();
    const a = createInventory("k", [], store);
    a.grant("Orion"); a.grant("Orion");
    const b = createInventory("k", [], store);
    expect(b.count("Orion")).toBe(2);
  });

  test("fires hooks on grant/melt and snapshots counts", () => {
    const grants: { id: string; isNew: boolean }[] = [];
    const melts: { id: string; melted: boolean }[] = [];
    const inv = createInventory("k", ["Starter"], memStore(), {
      onGrant: (id, isNew) => grants.push({ id, isNew }),
      onMelt: (id, melted) => melts.push({ id, melted }),
    });

    inv.grant("Orion");
    inv.grant("Orion");
    expect(grants).toEqual([{ id: "Orion", isNew: true }, { id: "Orion", isNew: false }]);

    expect(inv.melt("Orion")).toBe(true);
    expect(melts).toEqual([{ id: "Orion", melted: true }]);
    expect(inv.melt("Orion")).toBe(false); // last copy kept → melted:false still reported
    expect(melts[melts.length - 1]).toEqual({ id: "Orion", melted: false });

    expect(inv.snapshot()).toEqual({ Starter: 1, Orion: 1 });
  });

  test("hydrate replaces counts from a server snapshot (free floor re-applied, no hooks)", () => {
    const grants: unknown[] = [];
    const inv = createInventory("k", ["Starter"], memStore(), { onGrant: () => grants.push(1) });
    inv.grant("Orion");
    inv.hydrate({ Skull: 2, Helmet: 1 }); // server truth; Starter must survive as free
    expect(inv.owns("Orion")).toBe(false);
    expect(inv.count("Skull")).toBe(2);
    expect(inv.owns("Starter")).toBe(true);
    expect(grants.length).toBe(1); // hydrate fired no onGrant
  });
});
