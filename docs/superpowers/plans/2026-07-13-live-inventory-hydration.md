# Live Inventory Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a signed-in account's server-authoritative car collection appear in the live Garage immediately, without restarting the app.

**Architecture:** Extend the existing `Garage` interface with a full ownership reconciliation method that recalculates each car's lock state from the hydrated inventory and repaints changed cards. Wire the account hydration callback to invoke that method after `inventory.hydrate()`, using a nullable bridge reference because account synchronization is declared before the Garage instance.

**Tech Stack:** TypeScript, Vitest, jsdom, Three.js UI, Vite

## Global Constraints

- Railway remains authoritative for signed-in inventory.
- Reconciliation must support both locked-to-owned and owned-to-locked transitions.
- Free, non-pullable, benched, and coming-soon cars must preserve the existing `poolable()` boot rules.
- If the equipped car becomes locked, select the first available, non-coming-soon car through the existing `onPick` path.
- Hydration must not fire inventory grant or melt hooks or create duplicate server writes.
- The existing `garage.grant()` crate-unlock path must remain unchanged and functional.
- Do not change authentication, persistence formats, crate probabilities, or account migration behavior.
- Do not add em dashes to new user-facing copy.

---

### Task 1: Reconcile the Live Garage After Account Hydration

**Files:**
- Modify: `redline3d/src/ui/carpicker.ts`
- Modify: `redline3d/src/ui/carpicker.test.ts`
- Modify: `redline3d/src/main.ts`
- Create: `redline3d/src/core/inventory-hydration-main.test.ts`

**Interfaces:**
- Consumes: `poolable(car: { pool?: boolean; comingSoon?: boolean }): boolean` and `inventory.owns(name: string): boolean`.
- Produces: `Garage.reconcileOwnership(owns: (name: string) => boolean): void`.

- [ ] **Step 1: Write failing Garage reconciliation tests**

Add this focused behavior block to `redline3d/src/ui/carpicker.test.ts`:

```ts
describe("live Garage ownership reconciliation", () => {
  const roster = (): CarOption[] => [
    { name: "DeLorean", url: "/models/delorean.glb", locked: true },
    { name: "Solana Paper", url: "/models/trabant.glb", pool: false },
  ];

  it("unlocks a server-owned car without rebuilding the app", () => {
    const parent = document.createElement("div");
    const cars = roster();
    const garage = createCarPicker(parent, cars, () => {});

    garage.reconcileOwnership((name) => name === "DeLorean" || name === "Solana Paper");

    expect(cars[0].locked).toBe(false);
    expect(parent.querySelectorAll(".gcard")[0].classList.contains("locked")).toBe(false);
    expect(parent.querySelectorAll(".gcard")[0].textContent).not.toContain("LOCKED");
  });

  it("relocks an absent car and falls back when it was equipped", () => {
    const parent = document.createElement("div");
    const cars = roster();
    cars[0].locked = false;
    const picks: string[] = [];
    const garage = createCarPicker(parent, cars, (car) => picks.push(car.name));

    garage.reconcileOwnership((name) => name === "Solana Paper");

    expect(cars[0].locked).toBe(true);
    expect(parent.querySelectorAll(".gcard")[0].classList.contains("locked")).toBe(true);
    expect(picks).toEqual(["DeLorean", "Solana Paper"]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
cd redline3d
npx vitest run src/ui/carpicker.test.ts
```

Expected: FAIL because `Garage` has no `reconcileOwnership` method.

- [ ] **Step 3: Add a failing main-wiring regression test**

Create `redline3d/src/core/inventory-hydration-main.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";

let main = "";

beforeAll(async () => {
  const fs = await import("node:fs/promises");
  main = await fs.readFile(new URL("../main.ts", import.meta.url), "utf8");
});

describe("main inventory hydration wiring", () => {
  it("reconciles the live Garage after replacing inventory from Railway", () => {
    const hydrate = main.indexOf("inventory.hydrate(snap.cars);");
    const reconcile = main.indexOf("garageForHydration?.reconcileOwnership((name) => inventory.owns(name));");
    const bridge = main.indexOf("garageForHydration = garage;");

    expect(hydrate).toBeGreaterThanOrEqual(0);
    expect(reconcile).toBeGreaterThan(hydrate);
    expect(bridge).toBeGreaterThan(reconcile);
  });
});
```

- [ ] **Step 4: Run the main-wiring test and verify the red state**

Run:

```bash
cd redline3d
npx vitest run src/core/inventory-hydration-main.test.ts
```

Expected: FAIL because account hydration does not yet call Garage reconciliation.

- [ ] **Step 5: Implement the Garage reconciliation API**

In `redline3d/src/ui/carpicker.ts`, import `poolable`, add the method to `Garage`, remember the selected car in `select()`, and implement the method in the returned object:

```ts
import { TIERS, poolable, tierOf, type Rarity } from "../core/rarity";

export interface Garage {
  // existing members
  /** replace live card locks from an authoritative inventory snapshot */
  reconcileOwnership(owns: (name: string) => boolean): void;
}
```

```ts
let selectedEl: HTMLElement | null = null;
let selectedCar: CarOption | null = null;
const select = (el: HTMLElement, c: CarOption) => {
  if (c.locked || c.comingSoon) return;
  if (busy) {
    busyNote.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }],
      { duration: 240 },
    );
    return;
  }
  if (selectedEl) selectedEl.classList.remove("sel");
  el.classList.add("sel");
  selectedEl = el;
  selectedCar = c;
  onPick(c);
};
```

```ts
reconcileOwnership(owns) {
  let changed = false;
  cars.forEach((c, i) => {
    const locked = poolable(c) && !owns(c.name);
    if (!!c.locked === locked) return;
    c.locked = locked;
    cards[i] = fillCard(grid.children[i] as HTMLElement, c, i);
    changed = true;
  });
  if (!changed) return;
  rendered = false;
  if (selectedCar?.locked) {
    selectedEl = null;
    selectedCar = null;
    const firstOpen = cars.findIndex((c) => !c.locked && !c.comingSoon);
    if (firstOpen >= 0) select(grid.children[firstOpen] as HTMLElement, cars[firstOpen]);
  }
  if (view === "garage") renderArt();
},
```

- [ ] **Step 6: Wire reconciliation after account hydration**

In `redline3d/src/main.ts`, import the `Garage` type, add the bridge before `createAccountSync`, reconcile immediately after `inventory.hydrate()`, and assign the created Garage:

```ts
import { createCarPicker, type CarAbility, type Garage } from "./ui/carpicker";
```

```ts
let garageForHydration: Garage | null = null;
const accountSync = createAccountSync({
  api,
  nonce: String(Date.now()),
  applyServer: (snap) => {
    upgrades.hydrate({ coins: snap.coins, scrap: snap.scrap, levels: snap.levels });
    inventory.hydrate(snap.cars);
    garageForHydration?.reconcileOwnership((name) => inventory.owns(name));
  },
});
```

Immediately after the existing `createCarPicker(...)` expression:

```ts
garageForHydration = garage;
```

- [ ] **Step 7: Run focused tests and verify the green state**

Run:

```bash
cd redline3d
npx vitest run src/ui/carpicker.test.ts src/core/inventory-hydration-main.test.ts
```

Expected: both files pass, including the existing crate grant tests.

- [ ] **Step 8: Run complete verification**

Run:

```bash
cd redline3d
npm test
npm run build
```

Expected: 0 failed tests and an exit code of 0 for the production build.

- [ ] **Step 9: Review the diff and commit**

Run:

```bash
git diff --check
git status --short
git add redline3d/src/ui/carpicker.ts redline3d/src/ui/carpicker.test.ts redline3d/src/main.ts redline3d/src/core/inventory-hydration-main.test.ts
git commit -m "fix: refresh Garage after account hydration"
```
