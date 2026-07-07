# Scrap Yard & Scrap Economy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the earned `scrap` currency a real sink — the Scrap Yard, where you melt spare (duplicate) car copies into scrap and spend scrap on per-car cosmetic paint.

**Architecture:** Car ownership becomes a counted collection (dupes stack instead of auto-converting to scrap). Pure logic (counts, melt value, paint price) is isolated and unit-tested; the scrap balance + applied finishes live in the existing garage save (`upgrades.ts`); a new `ui/scrapyard.ts` overlay is the Melt Bay + Paint Shop; `car.ts` gains a `setFinish()` that recolors the model's materials so paint shows on the road.

**Tech Stack:** TypeScript, Vite, Three.js, Vitest. Client-side only (localStorage). Follows the existing overlay/store idioms in `ui/upgrades.ts` and `ui/cratebox.ts`.

**Spec:** [docs/superpowers/specs/2026-07-07-scrapyard-scrap-economy-design.md](../specs/2026-07-07-scrapyard-scrap-economy-design.md)

**Constraint (non-negotiable):** scrap is a terminal cosmetic currency — it never converts to coins, cars, or leverage.

---

## Task 1: Counted inventory

Turn the ownership `Set` into a count map, keeping `grant`/`owns`/`all` behavior identical (so existing call sites and tests still pass) and adding `count`/`spares`/`melt`/`meltable`. Migrates the legacy id-array on load.

**Files:**
- Modify: `redline3d/src/core/inventory.ts`
- Test: `redline3d/src/core/inventory.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `inventory.test.ts`)

```ts
import { describe, test, expect } from "vitest";
import { createInventory } from "./inventory";

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
  test("grant increments count and reports newlyOwned only on 0→1", () => {
    const inv = createInventory("k", [], memStore());
    expect(inv.grant("Orion")).toBe(true);   // newly owned
    expect(inv.count("Orion")).toBe(1);
    expect(inv.grant("Orion")).toBe(false);  // duplicate
    expect(inv.count("Orion")).toBe(2);
  });

  test("spares = count − 1; melt sheds a spare but never the last copy", () => {
    const inv = createInventory("k", [], memStore());
    inv.grant("Orion"); inv.grant("Orion"); inv.grant("Orion"); // ×3
    expect(inv.spares("Orion")).toBe(2);
    expect(inv.melt("Orion")).toBe(true);   // ×3 → ×2
    expect(inv.melt("Orion")).toBe(true);   // ×2 → ×1
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
    inv.grant("A"); inv.grant("A"); // ×2 → 1 spare
    inv.grant("B");                 // ×1 → 0 spares
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd redline3d && npx vitest run src/core/inventory.test.ts`
Expected: FAIL — `count`/`spares`/`melt`/`meltable` are not functions.

- [ ] **Step 3: Rewrite `inventory.ts`**

```ts
// Persistent ownership store — the source of truth for what the player has unlocked. Cars are a
// COUNTED collection (duplicates stack, and spare copies are melted at the Scrap Yard); level/world
// skins use the same store but only ever need own/not-own. Generic over a storage `key`.

export interface Inventory {
  owns(id: string): boolean;
  /** how many copies are owned (0 if never pulled) */
  count(id: string): number;
  /** grant a copy; returns true only on the 0→1 transition (a NEW unlock), false for a duplicate */
  grant(id: string): boolean;
  /** spare copies above the kept floor of 1 (0 if unowned or the only copy) */
  spares(id: string): number;
  /** shed one spare copy; no-op returning false if there is no spare (the last copy is never lost) */
  melt(id: string): boolean;
  all(): string[];
  /** cars that have at least one spare, with their total count */
  meltable(): { id: string; count: number }[];
}

/** `free` ids are always owned at count ≥ 1 (Starter / default level). `storage` is injectable for tests. */
export function createInventory(key: string, free: string[] = [], storage: Storage = localStorage): Inventory {
  const counts = new Map<string, number>();
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // legacy format: a JSON array of owned ids → one copy each (migration)
        for (const id of parsed as string[]) counts.set(id, Math.max(counts.get(id) ?? 0, 1));
      } else if (parsed && typeof parsed === "object") {
        for (const [id, n] of Object.entries(parsed as Record<string, unknown>)) {
          const c = Math.max(0, Math.floor(Number(n) || 0));
          if (c > 0) counts.set(id, c);
        }
      }
    }
  } catch { /* private mode / bad json → free items only */ }
  // free items are always present at ≥ 1
  for (const id of free) if ((counts.get(id) ?? 0) < 1) counts.set(id, 1);

  const persist = () => { try { storage.setItem(key, JSON.stringify(Object.fromEntries(counts))); } catch { /* ignore */ } };
  persist(); // stabilize free items across reloads even before the first grant

  return {
    owns: (id) => (counts.get(id) ?? 0) > 0,
    count: (id) => counts.get(id) ?? 0,
    grant: (id) => {
      const prev = counts.get(id) ?? 0;
      counts.set(id, prev + 1);
      persist();
      return prev === 0;
    },
    spares: (id) => Math.max(0, (counts.get(id) ?? 0) - 1),
    melt: (id) => {
      const prev = counts.get(id) ?? 0;
      if (prev <= 1) return false; // keep the last copy — melting only sheds spares
      counts.set(id, prev - 1);
      persist();
      return true;
    },
    all: () => [...counts.entries()].filter(([, n]) => n > 0).map(([id]) => id),
    meltable: () => [...counts.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ id, count: n })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd redline3d && npx vitest run src/core/inventory.test.ts`
Expected: PASS (new counted tests + the pre-existing grant/owns/all tests).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/inventory.ts redline3d/src/core/inventory.test.ts
git commit -m "feat(inventory): counted collection — dupes stack, spares meltable

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Melt valuation

A pure module for what a melt is worth. Reuses the crate `dupeScrap` scale so melt value == the old auto-dupe value (nothing inflates).

**Files:**
- Create: `redline3d/src/core/scrapyard.ts`
- Test: `redline3d/src/core/scrapyard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { meltValue, meltAllValue } from "./scrapyard";

describe("melt valuation", () => {
  test("melt value follows the rarity scale {3,6,12,25,50}", () => {
    expect(meltValue(1)).toBe(3);
    expect(meltValue(3)).toBe(12);
    expect(meltValue(5)).toBe(50);
    expect(meltValue(undefined)).toBe(3); // defaults to Common
  });

  test("meltAllValue sums value × spares", () => {
    expect(meltAllValue([
      { rarity: 1, spares: 3 }, // 3 × 3 = 9
      { rarity: 5, spares: 1 }, // 50 × 1 = 50
      { rarity: 3, spares: 0 }, // 0
    ])).toBe(59);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd redline3d && npx vitest run src/core/scrapyard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// Scrap Yard economics — what melting a spare copy is worth. Reuses the crate duplicate scale
// (core/crate.ts) so a melted spare pays exactly what an auto-scrapped dupe used to. Pure.
import { dupeScrap } from "./crate";

/** scrap paid for melting ONE spare copy of a car of the given rarity */
export const meltValue = (rarity?: number): number => dupeScrap(rarity);

/** total scrap from melting every spare in a set (spares = copies above the kept floor of 1) */
export function meltAllValue(items: { rarity?: number; spares: number }[]): number {
  return items.reduce((sum, it) => sum + meltValue(it.rarity) * Math.max(0, it.spares), 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd redline3d && npx vitest run src/core/scrapyard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/scrapyard.ts redline3d/src/core/scrapyard.test.ts
git commit -m "feat(scrapyard): melt valuation (reuses the dupe scale)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Paint catalog + pricing

The cosmetic sink's data: the finish set (Golden Paint + palette) and rarity-scaled prices. Pure. **Numbers are starting points to tune in playtest, not asserted balanced.**

**Files:**
- Create: `redline3d/src/core/paint.ts`
- Test: `redline3d/src/core/paint.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd redline3d && npx vitest run src/core/paint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// Cosmetic finishes bought at the Scrap Yard Paint Shop with scrap. `swatch` is both the UI dot
// and the color car.ts paints the model with. Pure catalog + pricing. Prices are starting points
// to tune in playtest (driving heaps + crate scrap are the primary funding; melt is supplementary).
import { tierOf } from "./rarity";

export interface Finish { id: string; name: string; swatch: string; }

export const FINISHES: readonly Finish[] = [
  { id: "gold",    name: "Golden Paint", swatch: "#ffcf5a" },
  { id: "crimson", name: "Crimson",      swatch: "#ff4d6d" },
  { id: "cyan",    name: "Cyber Cyan",   swatch: "#27e7ff" },
  { id: "violet",  name: "Ultraviolet",  swatch: "#b06bff" },
  { id: "mono",    name: "Gunmetal",     swatch: "#7b8494" },
];

export const finishById = (id: string): Finish | undefined => FINISHES.find((f) => f.id === id);

const BASE_PRICE: Readonly<Record<number, number>> = { 1: 120, 2: 200, 3: 350, 4: 600, 5: 1000 };

/** scrap to paint a car of the given rarity with `finishId`; Gold costs a premium */
export function paintPrice(rarity: number | undefined, finishId: string): number {
  const base = BASE_PRICE[tierOf(rarity).id];
  return finishId === "gold" ? Math.round(base * 1.5) : base;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd redline3d && npx vitest run src/core/paint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/paint.ts redline3d/src/core/paint.test.ts
git commit -m "feat(paint): finish catalog + rarity-scaled pricing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Scrap spend + applied finishes (garage save)

Add the sink hook `spendScrap()` (mirror of the coin `spend()`) and persist per-car finishes in the existing `redline.garage.v1` save.

**Files:**
- Modify: `redline3d/src/ui/upgrades.ts`
- Test: `redline3d/src/ui/upgrades.test.ts`

- [ ] **Step 1: Write the failing test** (append to `upgrades.test.ts`)

```ts
import { describe, test, expect, beforeEach } from "vitest";
import { createUpgrades } from "./upgrades";

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
    expect(u.spendScrap(9999)).toBe(false); // can't cover → no-op
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd redline3d && npx vitest run src/ui/upgrades.test.ts`
Expected: FAIL — `spendScrap`/`setFinish`/`finish` are not functions.

- [ ] **Step 3a: Extend the `Saved` type and its loader** (`upgrades.ts`)

Change the `Saved` type and `loadSaved()` (around lines 43–57):

```ts
type Saved = { coins: number; scrap: number; levels: Record<Track, number>; finishes: Record<string, string> };
function loadSaved(): Saved {
  const fresh: Saved = { coins: 0, scrap: 0, levels: { tank: 0, turbo: 0, suspension: 0 }, finishes: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fresh;
    const p = JSON.parse(raw);
    return {
      coins: Number.isFinite(p.coins) ? Math.max(0, Math.floor(p.coins)) : 0,
      scrap: Number.isFinite(p.scrap) ? Math.max(0, Math.floor(p.scrap)) : 0,
      levels: {
        tank: clampLevel(p.levels?.tank), turbo: clampLevel(p.levels?.turbo), suspension: clampLevel(p.levels?.suspension),
      },
      finishes: (p.finishes && typeof p.finishes === "object") ? p.finishes : {},
    };
  } catch { return fresh; }
}
```

- [ ] **Step 3b: Add the methods to the `Upgrades` interface** (after `addScrap(n): void;`)

```ts
  /** debit scrap for a Scrap Yard purchase; false + no-op if the balance can't cover it */
  spendScrap(n: number): boolean;
  /** the cosmetic finish applied to a car (by name), or undefined if unpainted */
  finish(carId: string): string | undefined;
  /** paint a car — persists the finish (the live car is repainted by the caller) */
  setFinish(carId: string, finishId: string): void;
```

- [ ] **Step 3c: Implement them in the returned object** (alongside `addScrap`)

```ts
    spendScrap(n) { if (saved.scrap < n) return false; saved.scrap = Math.max(0, saved.scrap - Math.floor(n)); persist(); opts.onScrap?.(saved.scrap); return true; },
    finish: (carId) => saved.finishes[carId],
    setFinish(carId, finishId) { saved.finishes[carId] = finishId; persist(); },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd redline3d && npx vitest run src/ui/upgrades.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/ui/upgrades.ts redline3d/src/ui/upgrades.test.ts
git commit -m "feat(upgrades): spendScrap sink + persisted per-car finishes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Car paint render (`setFinish`)

`car.ts` already collects `modelMats` (the model's MeshStandardMaterials) and re-tints them per load. Add a `setFinish()` that recolors those materials, re-applied after every model swap.

**Files:**
- Modify: `redline3d/src/render/car.ts`

- [ ] **Step 1: Add the import** (top of `car.ts`, after the existing imports)

```ts
import { finishById } from "../core/paint";
```

- [ ] **Step 2: Add finish state + apply function** (inside `createCar`, right after `applyTint` is defined, ~line 100)

```ts
  // cosmetic paint (Scrap Yard). Recolors the model's standard materials; re-applied on each load
  // because modelMats is rebuilt when the GLB swaps. Coexists with the equity emissive tint.
  let finishS: string | null = null;
  const applyFinish = () => {
    if (!modelMats || !finishS) return;
    const f = finishById(finishS);
    if (!f) return;
    for (const m of modelMats) { m.color.set(f.swatch); m.metalness = 0.9; m.roughness = 0.3; }
  };
```

- [ ] **Step 3: Re-apply the finish after a model loads** (in the load callback, immediately after the existing `applyTint();` at ~line 145)

```ts
        applyTint();
        applyFinish();
```

- [ ] **Step 4: Add `setFinish` to the interface and the api**

In the `Car` interface (after `setSteer`):

```ts
  /** apply a cosmetic paint finish (id from core/paint), or null to leave the model's own colors */
  setFinish(finishId: string | null): void;
```

In the returned `api` object (after `setModel: loadModel,`):

```ts
    setFinish(finishId) { finishS = finishId; applyFinish(); },
```

- [ ] **Step 5: Typecheck**

Run: `cd redline3d && npm run build`
Expected: build succeeds (no TS errors). This is a render change — visual proof happens in Task 8's browser verification.

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/render/car.ts
git commit -m "feat(car): setFinish paints the model materials

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Crate opener — dupes stack instead of auto-paying scrap

A duplicate pull now just stacks (the copy is realized as scrap later by melting). Remove the auto `dupeScrap` add; surface the new count in the reveal.

**Files:**
- Modify: `redline3d/src/ui/cratebox.ts`

- [ ] **Step 1: Drop the auto-dupe scrap in `doOpen`**

Find this block (~line 247):

```ts
    const isNew = deps.grantCar(car.name);
    let scrap = crate.scrap;
    if (isNew) deps.unlockUI(car.name);
    else scrap += dupeScrap(car.rarity); // dupe adds a melt bonus on top of the crate scrap
    deps.addScrap(scrap);
```

Replace with:

```ts
    const isNew = deps.grantCar(car.name);
    const scrap = crate.scrap; // dupes no longer auto-pay — the copy stacks, melted later at the Scrap Yard
    if (isNew) deps.unlockUI(car.name);
    deps.addScrap(scrap);
```

- [ ] **Step 2: Remove the now-unused `dupeScrap` import**

In the import from `../core/crate` (line 5), delete `dupeScrap,` (leave the rest). `tsc` will flag it as unused otherwise.

- [ ] **Step 3: Add a `carCount` dep so the reveal can show ×N**

In the `CrateBoxDeps` interface (near the top of `cratebox.ts`, where `grantCar`/`addScrap` are declared), add:

```ts
  carCount(name: string): number; // copies owned after this pull (for the "×N" duplicate reveal)
```

- [ ] **Step 4: Show "×N" on a duplicate reveal**

Locate the reveal builder: `grep -n "showReveal" src/ui/cratebox.ts`. In its duplicate branch (where `isNew` is false — today it shows the scrap bonus), render the stack count instead. Use the dep:

```ts
    // duplicate: no bonus scrap now — show that the copy stacked
    const n = deps.carCount(car.name);
    // …in the reveal's subtitle/label for a duplicate, show:  `DUPLICATE · now ×${n}`
```

Wire the label text into the existing duplicate line (replace the old `+${scrap} scrap` dupe caption with `now ×${n}`). Keep the crate's base-scrap line unchanged.

- [ ] **Step 5: Typecheck**

Run: `cd redline3d && npm run build`
Expected: succeeds. `main.ts` will error until Task 8 supplies `carCount` — if you run it standalone before Task 8, expect the missing-dep error there; otherwise proceed to Task 8 and typecheck together.

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/ui/cratebox.ts
git commit -m "feat(crate): duplicates stack (no auto-scrap); reveal shows xN

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Scrap Yard screen (new)

A self-contained overlay: **Melt Bay** (melt spares → scrap) + **Paint Shop** (spend scrap → per-car finish). Pure logic comes from Tasks 1–3; this file is DOM + wiring, verified in the browser.

**Files:**
- Create: `redline3d/src/ui/scrapyard.ts`

- [ ] **Step 1: Write the module**

```ts
// The Scrap Yard: the sink for the scrap currency. Two counters —
//   • Melt Bay: melt SPARE car copies (you always keep ≥1) into scrap.
//   • Paint Shop: spend scrap on a per-car cosmetic finish (Golden Paint + palette).
// Scrap is terminal + cosmetic — it never buys coins, cars, or leverage. Overlay idiom mirrors
// ui/upgrades.ts (injected styles + a fixed overlay + a render() that repaints on open/change).
import { coinLabel } from "../core/coins";
import { meltValue, meltAllValue } from "../core/scrapyard";
import { FINISHES, finishById, paintPrice } from "../core/paint";

export interface YardCar { name: string; rarity?: number; }
export interface ScrapYardDeps {
  scrap(): number;
  meltable(): { name: string; rarity?: number; spares: number }[];
  melt(name: string): boolean;                 // decrement one spare (returns success)
  addScrap(n: number): void;
  ownedCars(): YardCar[];                       // for the Paint Shop car list
  finishOf(name: string): string | undefined;
  spendScrap(n: number): boolean;
  setFinish(name: string, finishId: string): void; // persist + repaint the live car
  onClose?(): void;
}
export interface ScrapYard { open(): void; isOpen(): boolean; }

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .sy-panel{width:min(420px,94vw);max-height:88vh;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;
      background:rgba(12,10,26,.92);border-color:rgba(154,164,178,.3);pointer-events:auto}
    .sy-head{display:flex;align-items:center;gap:10px}
    .sy-head .lbl{flex:1}
    .sy-scrap{display:flex;align-items:center;gap:5px;font:700 14px/1 'Chakra Petch',ui-monospace,monospace;color:#c2cad6;text-shadow:0 0 9px rgba(154,164,178,.5)}
    .sy-x{cursor:pointer;color:var(--mut);font:700 16px/1 Chakra Petch,ui-monospace,monospace;padding:3px 5px;border:0;background:transparent}
    .sy-sect{font:700 11px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase;color:rgba(216,222,255,.6);margin-top:4px}
    .sy-row{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:10px;background:rgba(18,14,40,.72);border:1px solid rgba(132,150,224,.22)}
    .sy-row .nm{flex:1;font:700 12px/1 'Chakra Petch',ui-monospace,monospace;color:#fff}
    .sy-row .mul{font:600 11px/1 'Chakra Petch',ui-monospace,monospace;color:rgba(216,222,255,.65)}
    .sy-btn{border:0;border-radius:8px;padding:8px 12px;cursor:pointer;font:800 11px/1 'Chakra Petch',ui-monospace,monospace;
      letter-spacing:.06em;text-transform:uppercase;color:#04130d;background:linear-gradient(180deg,#c9d2de,#9aa4b2);box-shadow:0 3px 10px rgba(154,164,178,.3)}
    .sy-btn:disabled{cursor:not-allowed;color:var(--mut);background:rgba(255,255,255,.08);box-shadow:none}
    .sy-btn.gold{color:#231a04;background:linear-gradient(180deg,#ffd980,#ffcf5a)}
    .sy-empty{font:500 11px/1.4 'Chakra Petch',ui-monospace,monospace;color:var(--mut);padding:6px 2px}
    .sy-swatches{display:flex;gap:7px;flex-wrap:wrap}
    .sy-sw{width:26px;height:26px;border-radius:7px;cursor:pointer;border:2px solid transparent;box-shadow:0 0 0 1px rgba(0,0,0,.4)}
    .sy-sw.on{border-color:#fff}
    .sy-carsel{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:2px}
    .sy-chip{padding:6px 9px;border-radius:8px;cursor:pointer;font:600 10px/1 'Chakra Petch',ui-monospace,monospace;
      background:rgba(18,14,40,.7);border:1px solid rgba(132,150,224,.22);color:rgba(216,222,255,.8)}
    .sy-chip.on{border-color:var(--cyan);color:#fff}
  `;
  document.head.appendChild(s);
}

export function createScrapYard(parent: HTMLElement, deps: ScrapYardDeps): ScrapYard {
  injectStyles();

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:9", "display:none", "align-items:center", "justify-content:center",
    "padding:max(22px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(22px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))",
    "background:rgba(0,0,0,.8)", "backdrop-filter:blur(2px)", "pointer-events:auto",
  ].join(";");
  const panel = document.createElement("div");
  panel.className = "panel sy-panel";
  overlay.appendChild(panel);
  parent.appendChild(overlay);

  let paintSel = ""; // the car selected in the Paint Shop

  const render = () => {
    const melts = deps.meltable();
    const owned = deps.ownedCars();
    if (!paintSel && owned.length) paintSel = owned[0].name;
    const selCar = owned.find((c) => c.name === paintSel);
    const meltAll = meltAllValue(melts);

    panel.innerHTML =
      `<div class="sy-head"><span class="lbl">scrap yard</span>` +
      `<span class="sy-scrap">⚙ <span id="syScrap">${coinLabel(deps.scrap())}</span></span>` +
      `<button class="sy-x" aria-label="Close">✕</button></div>` +

      `<div class="sy-sect">Melt Bay — shed spare copies</div>` +
      (melts.length
        ? melts.map((m) => `
          <div class="sy-row" data-melt="${m.name}">
            <span class="nm">${m.name}</span>
            <span class="mul">×${m.count} · +${meltValue(m.rarity)} ea</span>
            <button class="sy-btn" data-melt-one="${m.name}">Melt 1</button>
          </div>`).join("") +
          `<button class="sy-btn" id="syMeltAll" style="width:100%">Melt all duplicates · +${meltAll} ⚙</button>`
        : `<div class="sy-empty">No spare cars yet — pull duplicates from crates and their copies stack here.</div>`) +

      `<div class="sy-sect">Paint Shop — spend scrap on a finish</div>` +
      (owned.length
        ? `<div class="sy-carsel">${owned.map((c) =>
            `<button class="sy-chip${c.name === paintSel ? " on" : ""}" data-paintcar="${c.name}">${c.name}</button>`).join("")}</div>` +
          `<div class="sy-swatches">${FINISHES.map((f) => {
            const price = paintPrice(selCar?.rarity, f.id);
            const applied = selCar && deps.finishOf(selCar.name) === f.id;
            return `<div class="sy-sw${applied ? " on" : ""}" title="${f.name} · ${price} ⚙" data-paint="${f.id}" style="background:${f.swatch}"></div>`;
          }).join("")}</div>` +
          `<button class="sy-btn gold" id="syBuyPaint" disabled>Pick a finish</button>`
        : `<div class="sy-empty">Own a car to paint it.</div>`);

    (panel.querySelector(".sy-x") as HTMLElement).onclick = () => setOpen(false);

    panel.querySelectorAll("[data-melt-one]").forEach((b) => (b as HTMLElement).onclick = () => {
      const name = (b as HTMLElement).dataset.meltOne!;
      const car = melts.find((m) => m.name === name);
      if (car && deps.melt(name)) { deps.addScrap(meltValue(car.rarity)); render(); }
    });
    const meltAllBtn = panel.querySelector("#syMeltAll") as HTMLButtonElement | null;
    if (meltAllBtn) meltAllBtn.onclick = () => {
      for (const m of melts) { let s = m.spares; while (s-- > 0 && deps.melt(m.name)) deps.addScrap(meltValue(m.rarity)); }
      render();
    };

    panel.querySelectorAll("[data-paintcar]").forEach((b) => (b as HTMLElement).onclick = () => {
      paintSel = (b as HTMLElement).dataset.paintcar!; render();
    });
    let pick = "";
    const buyBtn = panel.querySelector("#syBuyPaint") as HTMLButtonElement | null;
    panel.querySelectorAll("[data-paint]").forEach((sw) => (sw as HTMLElement).onclick = () => {
      pick = (sw as HTMLElement).dataset.paint!;
      panel.querySelectorAll(".sy-sw").forEach((x) => x.classList.remove("on"));
      (sw as HTMLElement).classList.add("on");
      if (buyBtn && selCar) {
        const price = paintPrice(selCar.rarity, pick);
        buyBtn.textContent = `${finishById(pick)?.name} · ${price} ⚙`;
        buyBtn.disabled = deps.scrap() < price;
      }
    });
    if (buyBtn) buyBtn.onclick = () => {
      if (!selCar || !pick) return;
      const price = paintPrice(selCar.rarity, pick);
      if (!deps.spendScrap(price)) return;
      deps.setFinish(selCar.name, pick);
      render();
    };
  };

  const setOpen = (open: boolean) => {
    overlay.style.display = open ? "flex" : "none";
    if (open) render(); else deps.onClose?.();
  };
  overlay.onclick = (e) => { if (e.target === overlay) setOpen(false); };
  addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.style.display !== "none") setOpen(false); });

  return { open: () => setOpen(true), isOpen: () => overlay.style.display !== "none" };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd redline3d && npm run build`
Expected: the module compiles (it will only be *used* once Task 8 wires it — that's fine).

- [ ] **Step 3: Commit**

```bash
git add redline3d/src/ui/scrapyard.ts
git commit -m "feat(scrapyard): Melt Bay + Paint Shop overlay

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Wire it up + verify the loop

Create the Scrap Yard in `main.ts`, feed the crate reveal its count, open the yard from the building, apply saved paint on equip, and fix stale "coming soon" copy.

**Files:**
- Modify: `redline3d/src/main.ts`
- Modify: `redline3d/src/ui/lobbyhud.ts`

- [ ] **Step 1: Import the Scrap Yard** (with the other `ui/*` imports near the top of `main.ts`)

```ts
import { createScrapYard } from "./ui/scrapyard";
```

- [ ] **Step 2: Add the `carCount` dep to the crate box** (in the `createCrateBox` deps, ~line 441, next to `grantCar`)

```ts
  carCount: (name) => inventory.count(name),
```

- [ ] **Step 3: Create the Scrap Yard** (after the `createCrateBox(...)` block, ~line 451)

```ts
// Scrap Yard (lobby building): melt spare car copies → scrap; spend scrap on per-car paint.
const scrapYard = createScrapYard(hudRoot, {
  scrap: () => upgrades.scrap(),
  meltable: () => inventory.meltable().map((m) => ({
    name: m.id,
    rarity: CAR_DEFS.find((c) => c.name === m.id)?.rarity,
    spares: m.count - 1,
  })),
  melt: (name) => inventory.melt(name),
  addScrap: (n) => upgrades.addScrap(n),
  ownedCars: () => inventory.all().map((name) => ({ name, rarity: CAR_DEFS.find((c) => c.name === name)?.rarity })),
  finishOf: (name) => upgrades.finish(name),
  spendScrap: (n) => upgrades.spendScrap(n),
  setFinish: (name, finishId) => {
    upgrades.setFinish(name, finishId);
    if (equippedCar.name === name) car.setFinish(finishId); // repaint the live road car immediately
  },
  onClose: () => { if (mode === "lobby") lobbyHud.show(); },
});
```

- [ ] **Step 4: Open the yard from the building** (replace the stale toast, ~line 635)

Find:

```ts
    case "scrapyard": lobbyHud.toast("ScrapYard — coming soon"); break; // collect scrap, not built yet
```

Replace with:

```ts
    case "scrapyard": scrapYard.open(); break;
```

- [ ] **Step 5: Apply the saved finish when a car is equipped** (in the car-picker `onPick` callback, ~line 392, right after `car.setModel(c.url, c.scale, c.yaw);`)

```ts
    car.setFinish(upgrades.finish(c.name) ?? null);
```

- [ ] **Step 6: Fix stale copy**

- `main.ts` ~line 455 comment `Crates (coming soon)` → `Crates`.
- `lobbyhud.ts` line 19: `desc: "Loot crates — coming soon"` → `desc: "Loot crates — cars & scrap"`.

- [ ] **Step 7: Full typecheck + tests**

Run: `cd redline3d && npm run build && npm test`
Expected: build succeeds; all tests pass (415+ prior + the new inventory/scrapyard/paint/upgrades tests).

- [ ] **Step 8: Verify the loop in the browser**

Start the dev server (preview_start), then:
1. Open the lobby, drive to the **Scrap Yard** building (or use the dev hook — `grep -n "triggerBuilding" src/main.ts` — e.g. `window.__hw.triggerBuilding("scrapyard")`), confirm the overlay opens (no "coming soon" toast).
2. If you have no spares yet: open Crates, pull the same car twice (dev hooks or coins), confirm the second pull reveals **"now ×2"** and did **not** jump the scrap total by the dupe bonus.
3. In the Scrap Yard Melt Bay, melt a spare → scrap total rises by the rarity value; the spare count drops; melting the last copy is impossible.
4. In the Paint Shop, pick the equipped car, buy **Golden Paint** → scrap debits, and the car on the road/turntable shows gold. Reload → the finish persists (equip applies `upgrades.finish`).

Capture a screenshot of a painted car + the Scrap Yard for the user.

- [ ] **Step 9: Commit**

```bash
git add redline3d/src/main.ts redline3d/src/ui/lobbyhud.ts
git commit -m "feat(scrapyard): wire Melt Bay + Paint Shop into the lobby

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deferred / follow-on (consciously out of this plan)

Not silent cuts — these are real, but the loop is complete and verifiable without them:

- **Garage showroom paint** — `render/garage-room.ts` uses its own GLTFLoader (not `car.ts`); it traverses materials at ~line 279, so a `setFinish` there mirrors Task 5. The road car shows paint now; the showroom turntable is the next increment.
- **Garage grid ×N badge + finish swatch** (`carpicker.ts` `fillCard`) — the count already surfaces in the crate reveal and the Melt Bay, and paint shows on the car itself, so the grid badge is redundant polish. Adding it means threading a `count`/`finishOf` dep + a `refresh()` into `createCarPicker`.
- **More cosmetics** (fire-trail colors, underglow, rims), **player marketplace**, **real-money paint / VRF**, **NFT burn-on-melt** — all per the spec's out-of-scope list.

## Self-review notes

- **Spec coverage:** counted inventory (T1), melt value (T2), paint catalog/price (T3), scrap sink + finishes (T4), car paint render (T5), dupe-stacking crate change (T6), Scrap Yard Melt Bay + Paint Shop (T7), wiring + the `"scrapyard"` case + stale-label fix (T8). Spec units 6 (garage card badge) and the showroom half of unit 8 are the documented deferrals above.
- **Type consistency:** `inventory` exposes `count/spares/melt/meltable`; `meltable()` returns `{id,count}` and `main.ts` maps it to the screen's `{name,rarity,spares}`; `upgrades` exposes `spendScrap/finish/setFinish`; `car.ts` exposes `setFinish`; melt value via `meltValue`/`meltAllValue`; paint via `FINISHES`/`finishById`/`paintPrice`. Names match across tasks.
- **No placeholders:** every code step shows real code. The only "locate then edit" step is T6/Step 4 (the crate reveal caption), which reads an existing function and changes one label line.
