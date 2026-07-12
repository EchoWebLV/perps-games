# Trabant Display Name and Additive Turbo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the starter car as Trabant without changing its stable inventory ID, and make every Turbo level add 50x above a high-base car such as Cybertruck.

**Architecture:** Add a shared pure leverage helper in `@perps/engine` and consume it from both server entitlement math and the live client ceiling. Add an optional car-aware leverage display mapper to the Upgrades UI. Add a separate `displayName` field to garage car definitions while preserving `name` as the persisted identity.

**Tech Stack:** TypeScript, Vitest, jsdom, Vite, shared `@perps/engine` workspace package

## Global Constraints

- Keep `perpz` unchanged as the regular-progression access code.
- Keep `Solana Paper` as the persisted inventory, server, entitlement, presence, and trade identity.
- Display `Trabant` on player-facing garage card and detail surfaces.
- Cybertruck leverage must be 1500x at Turbo level 0, 1550x at level 1, and 2000x at level 10.
- Keep the 3000x on-chain global clamp, Turbo pricing, ten-level limit, and all non-Turbo upgrade behavior unchanged.
- Do not migrate local storage or database inventory rows.

---

### Task 1: Shared Additive Car Leverage

**Files:**
- Modify: `packages/engine/src/entitlements.test.ts`
- Modify: `packages/engine/src/entitlements.ts`

**Interfaces:**
- Consumes: `BASE_CONFIG.RMAX`, an upgrade-adjusted global ceiling, and an optional car base ceiling.
- Produces: `carLeverageCeiling(upgradedRmax: number, carBaseLev?: number): number`.

- [ ] **Step 1: Write the failing engine regression test**

Extend the Cybertruck entitlement test with level 1 and level 10 expectations:

```ts
it("adds every Turbo level above Cybertruck's 1500x base", () => {
  expect(perkEnvelope({ turbo: 0, tank: 0, suspension: 0 }, { baseLev: 1500 }).maxLev).toBe(1500);
  expect(perkEnvelope({ turbo: 1, tank: 0, suspension: 0 }, { baseLev: 1500 }).maxLev).toBe(1550);
  expect(perkEnvelope({ turbo: 10, tank: 0, suspension: 0 }, { baseLev: 1500 }).maxLev).toBe(2000);
});
```

- [ ] **Step 2: Run the engine test and verify RED**

Run:

```bash
npm test --workspace @perps/engine -- src/entitlements.test.ts
```

Expected: FAIL because the current `Math.max(rmax, baseLev)` returns 1500 at Turbo level 1 and level 10.

- [ ] **Step 3: Implement the shared additive helper**

Add the helper and use it inside `perkEnvelope()`:

```ts
export function carLeverageCeiling(upgradedRmax: number, carBaseLev = 0): number {
  const turboBonus = Math.max(0, upgradedRmax - BASE_CONFIG.RMAX);
  return Math.max(BASE_CONFIG.RMAX, carBaseLev) + turboBonus;
}

// inside perkEnvelope
const rmax = BASE_CONFIG.RMAX + UPGRADE_STEP.turbo * turbo;
const ceil = carLeverageCeiling(rmax, car.baseLev);
```

- [ ] **Step 4: Run the engine test and verify GREEN**

Run:

```bash
npm test --workspace @perps/engine -- src/entitlements.test.ts
```

Expected: PASS with Cybertruck values 1500, 1550, and 2000.

- [ ] **Step 5: Commit the shared formula**

```bash
git add packages/engine/src/entitlements.ts packages/engine/src/entitlements.test.ts
git commit -m "fix(engine): stack turbo over car leverage"
```

---

### Task 2: Live Client Leverage Parity

**Files:**
- Modify: `redline3d/src/core/entitlements-parity.test.ts`
- Modify: `redline3d/src/main.ts`

**Interfaces:**
- Consumes: `carLeverageCeiling()` from `@perps/engine/entitlements`, mutable `CONFIG.RMAX`, and `carBaseLev`.
- Produces: `effRmax(upgradedRmax?: number): number`, with the existing Heavy Load multiplier applied after the additive ceiling.

- [ ] **Step 1: Write failing client parity and wiring tests**

Import `carLeverageCeiling` and `readFile`, then add:

```ts
it("Cybertruck Turbo level 1 is 1550x in shared and live client math", () => {
  const upgraded = trackValue(CONFIG.RMAX, 50, 1);
  const client = carLeverageCeiling(upgraded, 1500);
  expect(perkEnvelope(L(1), carPerk("Cybertruck")).maxLev).toBe(client);
  expect(client).toBe(1550);
});

it("main uses the shared additive car ceiling", async () => {
  const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  expect(main).toContain("carLeverageCeiling(upgradedRmax, carBaseLev)");
});
```

- [ ] **Step 2: Run the client parity test and verify RED**

Run:

```bash
cd redline3d && npx vitest run src/core/entitlements-parity.test.ts
```

Expected: the wiring assertion fails because `main.ts` still uses `Math.max(CONFIG.RMAX, carBaseLev)`.

- [ ] **Step 3: Use the shared helper in live client math**

Add the import and replace `effRmax`:

```ts
import { carLeverageCeiling } from "@perps/engine/entitlements";

const effRmax = (upgradedRmax = CONFIG.RMAX) => Math.round(
  carLeverageCeiling(upgradedRmax, carBaseLev)
  * (ability === "sixWheeler" ? HEAVY_LEV : 1),
);
```

- [ ] **Step 4: Run client parity and verify GREEN**

Run:

```bash
cd redline3d && npx vitest run src/core/entitlements-parity.test.ts
```

Expected: PASS, including the 1550x Cybertruck assertion and main wiring guard.

- [ ] **Step 5: Commit live client parity**

```bash
git add redline3d/src/core/entitlements-parity.test.ts redline3d/src/main.ts
git commit -m "fix: apply turbo above car base leverage"
```

---

### Task 3: Car-Aware Upgrade Values

**Files:**
- Modify: `redline3d/src/ui/upgrades.test.ts`
- Modify: `redline3d/src/ui/upgrades.ts`
- Modify: `redline3d/src/main.ts`

**Interfaces:**
- Consumes: Optional `leverageValue(upgradedRmax: number): number` in `createUpgrades()` options.
- Produces: Turbo current and next labels mapped through the selected car's effective ceiling.

- [ ] **Step 1: Write the failing Upgrades UI test**

Add a fresh-storage UI test:

```ts
it("shows selected-car leverage for the current and next Turbo level", () => {
  localStorage.clear();
  const root = document.createElement("div");
  const up = createUpgrades(root, { leverageValue: (rmax) => rmax + 500 });
  up.open();

  expect(root.querySelector('[data-val="turbo"]')?.textContent).toBe("1500×");
  expect(root.querySelector('[data-next="turbo"]')?.textContent).toContain("1550×");
});
```

- [ ] **Step 2: Run the Upgrades test and verify RED**

Run:

```bash
cd redline3d && npx vitest run src/ui/upgrades.test.ts
```

Expected: TypeScript or assertion failure because `leverageValue` is not supported and the UI renders 1000x to 1050x.

- [ ] **Step 3: Add the optional mapper and wire the selected car**

Extend the options type:

```ts
leverageValue?: (upgradedRmax: number) => number;
```

Inside `render()`, map only Turbo values:

```ts
const shownValue = (t: TrackDef, value: number) =>
  t.key === "turbo" && opts.leverageValue ? opts.leverageValue(value) : value;

// current
t.fmt(shownValue(t, val));

// next
t.fmt(shownValue(t, nextVal));
```

Pass the live mapper from `main.ts`:

```ts
leverageValue: (upgradedRmax) => effRmax(upgradedRmax),
```

- [ ] **Step 4: Run Upgrades and parity tests and verify GREEN**

Run:

```bash
cd redline3d && npx vitest run src/ui/upgrades.test.ts src/core/entitlements-parity.test.ts
```

Expected: PASS with car-aware Turbo labels and unchanged non-Turbo tracks.

- [ ] **Step 5: Commit the upgrade display**

```bash
git add redline3d/src/ui/upgrades.ts redline3d/src/ui/upgrades.test.ts redline3d/src/main.ts
git commit -m "fix: show car-aware turbo values"
```

---

### Task 4: Trabant Player-Facing Label

**Files:**
- Modify: `redline3d/src/ui/carpicker.test.ts`
- Modify: `redline3d/src/ui/carpicker.ts`
- Modify: `redline3d/src/main.ts`

**Interfaces:**
- Consumes: Stable `CarOption.name` and optional `CarOption.displayName`.
- Produces: `carDisplayName(car: CarOption): string`, used by visible garage card, detail, and image alternative text.

- [ ] **Step 1: Write the failing stable-ID/display-label test**

Add:

```ts
test("shows Trabant while preserving Solana Paper as the selected inventory ID", () => {
  const parent = document.createElement("div");
  const picks: string[] = [];
  createCarPicker(parent, [
    { name: "Solana Paper", displayName: "Trabant", url: "/models/trabant.glb" },
  ], (car) => picks.push(car.name));

  expect(parent.querySelector(".gtitle-name")?.textContent).toBe("Trabant");
  expect(picks).toEqual(["Solana Paper"]);
  (parent.querySelector(".gcard") as HTMLElement).click();
  expect(parent.querySelector(".gdcard-name")?.textContent).toBe("Trabant");
});
```

- [ ] **Step 2: Run the garage test and verify RED**

Run:

```bash
cd redline3d && npx vitest run src/ui/carpicker.test.ts
```

Expected: TypeScript or assertion failure because `displayName` does not exist and the visible label remains `Solana Paper`.

- [ ] **Step 3: Add and use the display label**

Extend `CarOption` and add the helper:

```ts
export interface CarOption {
  name: string;
  displayName?: string;
  // existing fields
}

export const carDisplayName = (car: CarOption): string => car.displayName ?? car.name;
```

In card and detail rendering, compute `const displayName = carDisplayName(c)` and use it for `.gtitle-name`, `.gdcard-name`, and image `alt`. Keep every ownership lookup, `grant()`, callback, and `carId` on `c.name`.

Set the starter definition in `main.ts`:

```ts
{
  name: "Solana Paper",
  displayName: "Trabant",
  url: "/models/trabant.glb",
  rarity: 1,
  pool: false,
  yaw: Math.PI / 2,
  power: { name: "Two-Stroke", desc: "0–60, eventually", icon: "clock" },
},
```

- [ ] **Step 4: Run garage and access tests and verify GREEN**

Run:

```bash
cd redline3d && npx vitest run src/ui/carpicker.test.ts src/core/access-code.test.ts
```

Expected: PASS. Garage text reads Trabant while `perpz` still owns only stable ID `Solana Paper` and grants zero coins.

- [ ] **Step 5: Commit the display rename**

```bash
git add redline3d/src/ui/carpicker.ts redline3d/src/ui/carpicker.test.ts redline3d/src/main.ts
git commit -m "feat: display starter car as Trabant"
```

---

### Task 5: Full Verification

**Files:**
- Verify only; no production files created.

**Interfaces:**
- Consumes: All changes from Tasks 1 through 4.
- Produces: Test, build, and visual evidence for the completed behavior.

- [ ] **Step 1: Run shared engine and server entitlement tests**

```bash
npm test --workspace @perps/engine
npm test --workspace @perps/server -- src/services/entitlements.test.ts
```

Expected: both commands exit with code 0.

- [ ] **Step 2: Run the complete client suite and production build**

```bash
cd redline3d
npm test
npm run build
```

Expected: all non-devnet tests pass, devnet-only tests remain skipped, and Vite exits with code 0.

- [ ] **Step 3: Verify the rendered behavior**

Use the local web app or a temporary Vite harness that instantiates the real `createCarPicker()` and `createUpgrades()` modules. Confirm:

- The starter garage card and detail view say `Trabant`.
- Selecting it still returns stable ID `Solana Paper`.
- Cybertruck Turbo displays `1500x` current and `1550x` next at level 0.
- After one purchase, the live effective ceiling and current label are `1550x`.

Delete any temporary harness before continuing.

- [ ] **Step 4: Check scope and workspace cleanliness**

```bash
git diff --check
rg -n "\[DEBUG-" packages/engine/src redline3d/src server/src || true
git status --short
```

Expected: no whitespace errors, no debug instrumentation, and only pre-existing unrelated files remain untracked or modified.
