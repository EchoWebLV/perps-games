# Slopwheels Gacha Collection Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boot the game into a 2D Slopwheels collection/storefront home; owned cars enter races (extracted from the dev prototype into an in-app mode) with rake-share podium payouts; lobby/perps become destinations.

**Architecture:** `src/main.ts` gains a `"home"` boot mode (2D DOM, no 3D render) and a `"grandprix"` race mode (the existing `"race"` mode key is the perps road — do NOT reuse it). The race sim is extracted from `src/race-preview.ts` into a shared `createRaceGame()` module consumed by both the app and the untouched dev harness. Heavy world construction is deferred behind a memoized `ensureWorlds()`. Pure logic (grid assembly, stats mapping, owner podium) lives in `src/core/` with unit tests.

**Tech Stack:** Three.js + Vite + vitest (existing). No new dependencies. All paths relative to `redline3d/` unless prefixed. Run all commands from `redline3d/`.

**Spec:** `docs/superpowers/specs/2026-07-24-slopwheels-gacha-home-design.md`

**Two deliberate deviations from the spec, both for cause:**
1. The loadscreen is the existing inline `#splash` in `play/index.html` restyled to Slopwheels + honest milestone progress — an external `ui/loadscreen.ts` module cannot render before the JS bundle loads, which is the whole point of a loadscreen. A tiny `window.setSplashProgress` bridge keeps main.ts in charge of real progress.
2. Home card art uses the baked PNGs in `public/cards/` (refreshed via `npm run bake:cards`), not live GLB renders — live-rendering 27 GLBs at boot would rebuild the 3D cost the home exists to avoid.

**Ground-truth anchors (verified 2026-07-24):** `mode` union `main.ts:930`; boot tail `precompileModes()` + `enterLobby()` `main.ts:2159–2162`; eager constructors `createWorld :142`, `createCar :170`, `createLobby :786`, `createOval :846`, `createGarageRoom :891`; `triggerBuilding :1091`; frame dispatcher `:1799`; `DEV_UNLOCK :641`; `levels` seeded from `world.currentTheme()` `:597`; splash contract `play/index.html:157–196` (`window.hideSplash`); race prototype structures per `src/race-preview.ts` (SPECS `:39`, STRENGTH `:66`, setupRace `:337`, phase fns `:363–:421`); `BetPanel` API `src/ui/bet-panel.ts:20` (RAKE `:38`, settle `:284`); `CarOption` `src/ui/carpicker.ts:11`; `Inventory` `src/core/inventory.ts:5`. Line numbers drift as tasks land — re-grep the named symbols, don't trust raw numbers late in the plan.

---

### Task 1: Owner podium payout math (`core/race-payout.ts`)

**Files:**
- Create: `src/core/race-payout.ts`
- Test: `src/core/race-payout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/race-payout.test.ts
import { describe, expect, it } from "vitest";
import { RAKE, OWNER_POOL_SHARE, PODIUM_SPLIT, ownerPodiumPayout } from "./race-payout";

describe("ownerPodiumPayout", () => {
  it("keeps the locked economy constants", () => {
    expect(RAKE).toBe(0.05);
    expect(OWNER_POOL_SHARE).toBe(0.4);
    expect(PODIUM_SPLIT).toEqual([0.5, 0.3, 0.2]);
  });
  it("pays the podium from the rake slice, to the cent", () => {
    // pool $250 → rake $12.50 → owner pool $5.00 → 2.50 / 1.50 / 1.00
    expect(ownerPodiumPayout(250, 0)).toBe(2.5);
    expect(ownerPodiumPayout(250, 1)).toBe(1.5);
    expect(ownerPodiumPayout(250, 2)).toBe(1.0);
  });
  it("pays zero off the podium and on an empty pool", () => {
    expect(ownerPodiumPayout(250, 3)).toBe(0);
    expect(ownerPodiumPayout(250, 7)).toBe(0);
    expect(ownerPodiumPayout(0, 0)).toBe(0);
  });
  it("rounds to cents (banker-free, plain round)", () => {
    // pool $33.33 → rake 1.6665 → owner pool 0.6666 → 1st 0.3333 → $0.33
    expect(ownerPodiumPayout(33.33, 0)).toBe(0.33);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/race-payout.test.ts`
Expected: FAIL — cannot resolve `./race-payout`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/race-payout.ts
// Demo race economy — the single config the spec promises. Rake is shared with the
// bet panel (import from here, never redeclare). Owners of the top-3 finishers split
// a fixed slice of the rake, so the house keeps the rest and can never lose.
export const RAKE = 0.05;                    // fraction of the betting pool
export const OWNER_POOL_SHARE = 0.4;         // fraction of the rake paid to owners
export const PODIUM_SPLIT = [0.5, 0.3, 0.2]; // 1st / 2nd / 3rd of the owner pool

/** What the OWNER of the car finishing at `rank` (0-based) earns from a betting pool. */
export function ownerPodiumPayout(poolTotal: number, rank: number): number {
  const share = PODIUM_SPLIT[rank] ?? 0;
  return Math.round(poolTotal * RAKE * OWNER_POOL_SHARE * share * 100) / 100;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/race-payout.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Point the bet panel at the shared RAKE and commit**

In `src/ui/bet-panel.ts`, delete the local `const RAKE = 0.05;` (line ~38) and add to the imports:

```ts
import { RAKE } from "../core/race-payout";
```

Run: `npx vitest run && npx tsc --noEmit` — full suite green, typecheck clean.

```bash
git add src/core/race-payout.ts src/core/race-payout.test.ts src/ui/bet-panel.ts
git commit -m "feat: owner podium payout math, single rake source"
```

---

### Task 2: Grid assembly + stats mapping (`core/race-grid.ts`)

**Files:**
- Create: `src/core/race-grid.ts`
- Test: `src/core/race-grid.test.ts`
- Reference (read only): `src/ui/carpicker.ts:8–20` (`CarOption`, `CarAbility`), `src/race-preview.ts:39–69` (`RaceSpec`, `STRENGTH`)

- [ ] **Step 1: Write the failing test**

```ts
// src/core/race-grid.test.ts
import { describe, expect, it } from "vitest";
import type { CarOption } from "../ui/carpicker";
import { GRID_SIZE, STRENGTH, surgeAmpBonus, buildGrid } from "./race-grid";

const car = (name: string, rarity: 1 | 2 | 3 | 4 | 5, extra: Partial<CarOption> = {}): CarOption =>
  ({ name, url: `/models/${name.toLowerCase()}.glb`, rarity, ...extra });

const ROSTER: CarOption[] = [
  car("Alpha", 1), car("Bravo", 2), car("Charlie", 3), car("Delta", 4, { ability: "nitro" }),
  car("Echo", 5), car("Foxtrot", 3), car("Golf", 2), car("Hotel", 1), car("India", 4),
];

// deterministic rng stub: cycles a fixed tape so tests never flake
const rngTape = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]; };

describe("buildGrid", () => {
  it("puts the player's car first and fills to GRID_SIZE with distinct house cars", () => {
    const grid = buildGrid(ROSTER, "Charlie", rngTape([0.1, 0.9, 0.4, 0.7, 0.2, 0.6, 0.3]));
    expect(grid).toHaveLength(GRID_SIZE);
    expect(grid[0].name).toBe("Charlie");
    expect(grid[0].isPlayer).toBe(true);
    expect(grid.slice(1).every((e) => !e.isPlayer)).toBe(true);
    expect(new Set(grid.map((e) => e.name)).size).toBe(GRID_SIZE); // no duplicates
  });
  it("builds an all-house grid for spectate mode (null player car)", () => {
    const grid = buildGrid(ROSTER, null, rngTape([0.5, 0.15, 0.85, 0.35, 0.65, 0.05, 0.95, 0.45]));
    expect(grid).toHaveLength(GRID_SIZE);
    expect(grid.every((e) => !e.isPlayer)).toBe(true);
  });
  it("carries model url/scale/yaw and maps rarity to strength", () => {
    const grid = buildGrid(ROSTER, "Echo", rngTape([0.2, 0.4, 0.6, 0.8]));
    expect(grid[0].url).toBe("/models/echo.glb");
    expect(grid[0].strength).toBe(STRENGTH[5]);
  });
  it("gives ability cars their surge amp bonus", () => {
    expect(surgeAmpBonus("nitro")).toBeGreaterThan(0);
    expect(surgeAmpBonus(undefined)).toBe(0);
    const grid = buildGrid(ROSTER, "Delta", rngTape([0.3, 0.7, 0.1, 0.9]));
    expect(grid[0].surgeAmpBonus).toBe(surgeAmpBonus("nitro"));
  });
  it("excludes pool:false and comingSoon cars from house fill", () => {
    const roster = [...ROSTER, car("Benched", 3, { pool: false }), car("Taped", 3, { comingSoon: true })];
    for (let s = 0; s < 20; s++) {
      const grid = buildGrid(roster, "Alpha", rngTape([s / 20, 0.33, 0.77, 0.51]));
      expect(grid.some((e) => e.name === "Benched" || e.name === "Taped")).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/race-grid.test.ts`
Expected: FAIL — cannot resolve `./race-grid`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/race-grid.ts
// Pure grid assembly for a race: the player's equipped car (or none, for spectate)
// plus house cars drawn from the roster. The stats mapping table the spec promises
// lives here: rarity → base strength (moved from race-preview), ability → surge amp bonus.
import type { CarOption, CarAbility } from "../ui/carpicker";

export const GRID_SIZE = 8;

/** rarity → outcome-scoring strength (source of truth; race-preview re-imports this). */
export const STRENGTH: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 1.0, 2: 1.35, 3: 1.8, 4: 2.4, 5: 3.2 };

/** Perk flavor on the sim: a small extra surge amplitude for aggressive abilities. */
const SURGE_AMP_BONUS: Partial<Record<CarAbility, number>> = {
  nitro: 0.06, pinkRod: 0.05, slots: 0.04, flux: 0.03, swerve: 0.03,
};
export function surgeAmpBonus(ability: CarAbility | undefined): number {
  return (ability && SURGE_AMP_BONUS[ability]) || 0;
}

export interface GridEntrant {
  name: string; url: string; scale?: number; yaw?: number;
  rarity: 1 | 2 | 3 | 4 | 5; strength: number; surgeAmpBonus: number; isPlayer: boolean;
}

const raceable = (c: CarOption): boolean => c.pool !== false && !c.comingSoon;

function toEntrant(c: CarOption, isPlayer: boolean): GridEntrant {
  const rarity = (c.rarity ?? 1) as 1 | 2 | 3 | 4 | 5;
  return {
    name: c.name, url: c.url, scale: c.scale, yaw: c.yaw,
    rarity, strength: STRENGTH[rarity], surgeAmpBonus: surgeAmpBonus(c.ability), isPlayer,
  };
}

/** Player car (by name, or null to spectate) + house fill, no duplicates, GRID_SIZE total. */
export function buildGrid(roster: CarOption[], playerCarName: string | null, rng: () => number): GridEntrant[] {
  const grid: GridEntrant[] = [];
  const player = playerCarName ? roster.find((c) => c.name === playerCarName) : undefined;
  if (player) grid.push(toEntrant(player, true));
  const pool = roster.filter((c) => raceable(c) && c.name !== player?.name);
  // Fisher–Yates on a copy, driven by the caller's rng so outcomes stay seedable.
  const bag = [...pool];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  for (const c of bag) {
    if (grid.length >= GRID_SIZE) break;
    grid.push(toEntrant(c, false));
  }
  return grid;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/race-grid.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/race-grid.ts src/core/race-grid.test.ts
git commit -m "feat: race grid assembly + rarity/perk stats mapping"
```

---

### Task 3: Bet panel `credit()` for owner winnings

**Files:**
- Modify: `src/ui/bet-panel.ts` (interface `:20`, factory `:143`)
- Test: `src/ui/bet-panel.test.ts` (create if absent; check first — if a test file exists, append)

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/bet-panel.test.ts (append if the file already exists)
import { describe, expect, it } from "vitest";
import { createBetPanel } from "./bet-panel";

describe("betPanel.credit", () => {
  it("adds owner winnings to the wallet and reports them in results", () => {
    const el = document.createElement("div");
    const panel = createBetPanel(el);
    const before = panel.wallet();
    panel.credit(2.5, "Podium — P1");
    expect(panel.wallet()).toBeCloseTo(before + 2.5, 2);
    expect(el.textContent).toContain("Podium — P1");
    panel.dispose();
  });
  it("ignores non-positive credits", () => {
    const el = document.createElement("div");
    const panel = createBetPanel(el);
    const before = panel.wallet();
    panel.credit(0, "nothing");
    panel.credit(-5, "nothing");
    expect(panel.wallet()).toBe(before);
    panel.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/bet-panel.test.ts`
Expected: FAIL — `panel.credit is not a function`.

- [ ] **Step 3: Implement `credit`**

In `src/ui/bet-panel.ts`:
1. Add to the `BetPanel` interface (after `settle(...)`):

```ts
  /** Add non-bet winnings (owner podium) to the wallet; label shows in the results strip. */
  credit(amount: number, label: string): void;
```

2. Inside `createBetPanel`, next to `settle`'s wallet mutation, add the implementation and expose it on the returned object. Follow the panel's existing DOM idiom (it builds rows with `document.createElement` — mirror how `settle` writes its result line; re-read that code before writing):

```ts
  function credit(amount: number, label: string): void {
    if (!(amount > 0)) return;
    wallet += amount;
    creditLine = `${label}: +$${amount.toFixed(2)}`; // rendered alongside the settle result
    renderWallet();                                  // reuse the panel's existing wallet refresh
  }
```

`creditLine` is a new module-let next to the existing result state; clear it where the panel resets for a new market (`openMarket`). If the panel has no `renderWallet`-style helper, update the same DOM node `settle` updates — do not invent a parallel render path.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ui/bet-panel.test.ts && npx vitest run`
Expected: new tests PASS; full suite stays green.

- [ ] **Step 5: Commit**

```bash
git add src/ui/bet-panel.ts src/ui/bet-panel.test.ts
git commit -m "feat: bet panel credit() for owner podium winnings"
```

---

### Task 4: Extract the race sim into `render/race-mode.ts` (shared with the dev harness)

**Files:**
- Create: `src/render/race-mode.ts`
- Modify: `src/race-preview.ts` (becomes a thin harness over the extraction)
- Test: `src/render/race-mode.test.ts`
- Do NOT touch: `race-preview.html`

This is a MOVE, not a rewrite. `src/race-preview.ts` (625 lines) keeps only: renderer/composer/camera/lights/resize/OrbitControls/dev-page boot (`:84–:150`, `:156`, `:547–:625` loop scaffolding). Everything race-logic moves into `createRaceGame()`:

| Moves to race-mode.ts (from race-preview.ts) | Anchor |
|---|---|
| `mulberry32` | `:71` |
| SPECS → DELETED; grid comes in via options (`GridEntrant[]` from Task 2). Keep a `DEFAULT_GRID` export replicating the 8 SPECS for the harness. | `:39–:49` |
| Constants `MODEL_YAW…OUTCOME_NOISE` (STRENGTH now imports from `core/race-grid`) | `:53–:69` |
| `RaceCar`, `Surge` interfaces + car build from grid | `:184–:242` |
| track/environment/director/camControls/hud/betPanel construction + roster wiring | `:110–:292` |
| pacing: `surgeBoost`, `calibrateBase`, `surgesForRank`, `setupRace` | `:298–:361` |
| phase machine: `enterMarket`, `lockAndCountdown`, `enterFinish`, `restart`, `advance`, `step` | `:363–:421` |
| render-side: `placeCars`, `order`, `leaderDist/currentLap/countdownLabel`, focus/director glue, `pushUi` | `:424–:513` |
| dev hooks `__raceState`/`__warp` (installed only when `opts.devHooks`) | `:516–:545` |
| `warm`, `loadCar` | `:560–:595` |

- [ ] **Step 1: Define the public surface (write this exact interface in race-mode.ts first)**

```ts
// src/render/race-mode.ts
import * as THREE from "three";
import type { GridEntrant } from "../core/race-grid";

export interface RaceGameOptions {
  scene: THREE.Scene;                 // race group + environment are added/removed here
  camera: THREE.PerspectiveCamera;    // the director aims this
  hudParent: HTMLElement;             // race-hud / bet-panel / cam-controls mount here
  grid: GridEntrant[];                // from buildGrid(); player car may be grid[0]
  seed: number;                       // race outcome seed (mulberry32)
  lowTier: boolean;                   // quality flag (mirrors main.ts quality.detail)
  devHooks?: boolean;                 // install window.__raceState / __warp (harness only)
  onExit?: (result: RaceResult) => void; // fired when the player leaves after FINISH
}
export interface RaceResult {
  finishOrder: number[];              // grid indices, winner first
  playerRank: number | null;          // 0-based, null when no player car in grid
  poolTotal: number;                  // betting pool at lock, for podium math
}
export interface RaceGame {
  update(dt: number): void;           // call from the host rAF loop
  phase(): "LOADING" | "MARKET" | "COUNTDOWN" | "RACING" | "FINISH";
  requestExit(): void;                // exits at the next safe phase boundary
  dispose(): void;                    // full teardown: scene groups, HUD DOM, materials
}
export function createRaceGame(opts: RaceGameOptions): RaceGame { /* moved code */ }
export function mulberry32(seed: number): () => number;      // moved from race-preview.ts:71, now exported
export const DEFAULT_GRID: GridEntrant[] = [ /* the 8 ex-SPECS, verbatim fields */ ];
```

Inside, the moved code changes in exactly these ways:
- every `document.body` HUD default → `opts.hudParent` (`createRaceHud(opts.hudParent)`, `createBetPanel(opts.hudParent)`, `createCamControls(grid.length, opts.hudParent)`).
- every `scene.add(...)` on the prototype's own scene → `opts.scene.add(...)`; `dispose()` removes the same groups and calls `track.dispose()` / `environment.dispose()` / hud/panel/controls `.dispose()` (they already reclaim toon variants after merge `be1e59d`).
- `setupRace()` scoring line becomes `const score = c.entrant.strength + rng() * OUTCOME_NOISE;` and surge amplitude gains `+ c.entrant.surgeAmpBonus` where `surgesForRank` amplitudes apply.
- `enterFinish()` no longer only settles bets; it also computes the exit payload:

```ts
const finishOrder = order();
const playerIdx = grid.findIndex((g) => g.isPlayer);
lastResult = {
  finishOrder,
  playerRank: playerIdx >= 0 ? finishOrder.indexOf(playerIdx) : null,
  poolTotal: betPanel.poolTotal(),
};
betPanel.settle(finishOrder[0]);
```
- the bloom/edge composer, OrbitControls, resize handling, and the rAF loop DO NOT move — the host owns rendering; `update(dt)` runs `step`, `placeCars`, director aim, `pushUi`, `track.update`, `environment.update`.

- [ ] **Step 2: Write the failing sim test (also covers the hidden-tab/`__warp` lesson)**

```ts
// src/render/race-mode.test.ts
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createRaceGame, DEFAULT_GRID } from "./race-mode";

// GLB loads are async and irrelevant to sim math: the placeholder anchors race fine.
// If createRaceGame awaits loads before MARKET, stub GLTFLoader like car.test.ts does
// (read src/render/car.test.ts:20–60 for the established loader-mock pattern and reuse it).

function makeGame(overrides = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const hudParent = document.createElement("div");
  return createRaceGame({ scene, camera, hudParent, grid: DEFAULT_GRID, seed: 42, lowTier: true, ...overrides });
}

describe("createRaceGame", () => {
  it("runs LOADING → MARKET → COUNTDOWN → RACING → FINISH deterministically", () => {
    const game = makeGame();
    // drive with fixed small steps until FINISH or a hard cap
    for (let t = 0; t < 300 && game.phase() !== "FINISH"; t += 1 / 30) game.update(1 / 30);
    expect(game.phase()).toBe("FINISH");
    game.dispose();
  });
  it("settles exactly once under one giant throttled-tab dt", () => {
    const game = makeGame();
    // reach RACING with normal steps first
    while (game.phase() !== "RACING") game.update(1 / 30);
    game.update(600); // 10 minutes in one tick — hidden-tab reality
    expect(game.phase()).toBe("FINISH");
    game.dispose();
  });
  it("same seed → same finish order, every index present exactly once", () => {
    let a: number[] = [], b: number[] = [], c: number[] = [];
    const run = (seed: number, sink: (r: { finishOrder: number[] }) => void) => {
      const g = makeGame({ seed, onExit: sink });
      for (let t = 0; t < 300 && g.phase() !== "FINISH"; t += 1 / 30) g.update(1 / 30);
      g.requestExit(); g.update(1 / 30); g.dispose();
    };
    run(7, (r) => (a = r.finishOrder)); run(7, (r) => (b = r.finishOrder)); run(8, (r) => (c = r.finishOrder));
    expect(a).toEqual(b);
    expect(a.length).toBe(DEFAULT_GRID.length);
    expect([...new Set(a)].length).toBe(a.length);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/render/race-mode.test.ts`
Expected: FAIL — cannot resolve `./race-mode`.

- [ ] **Step 4: Perform the move per the table + surface above**

Also fix the typo when transcribing the test: `PerspectiiveCamera` → `PerspectiveCamera` (leave no trace of the typo in the committed test).

- [ ] **Step 5: Run the new test, then the whole suite**

Run: `npx vitest run src/render/race-mode.test.ts` → PASS.
Run: `npx vitest run && npx tsc --noEmit` → suite green, typecheck clean.

- [ ] **Step 6: Re-point the dev harness**

`src/race-preview.ts` keeps its renderer/composer/camera/lights/resize/OrbitControls/loop and replaces all moved logic with:

```ts
import { createRaceGame, DEFAULT_GRID } from "./render/race-mode";
const game = createRaceGame({
  scene, camera, hudParent: document.body, grid: DEFAULT_GRID,
  seed: Date.now() % 100000, lowTier: false, devHooks: true,
});
// in loop(): game.update(dt); composer.render();
```

- [ ] **Step 7: Verify the harness in the browser**

Start the dev server (preview tooling), open `/race-preview.html`, and confirm: cars load, betting opens, countdown, race runs, settlement lands, `window.__warp(60)` still fast-forwards. Console free of new errors.

- [ ] **Step 8: Commit**

```bash
git add src/render/race-mode.ts src/render/race-mode.test.ts src/race-preview.ts
git commit -m "refactor: extract race sim into createRaceGame, harness consumes it"
```

---

### Task 5: Slopwheels loadscreen (splash restyle + honest progress)

**Files:**
- Modify: `play/index.html` (`#splash` block `:135–:196`, `<title>`)
- Modify: `src/main.ts` (milestone calls; `createBootReveal` `:166`)
- Asset (exists): `public/assets/brands/slopwheels.png`

- [ ] **Step 1: Restyle the splash**

In `play/index.html`: set `<title>Slopwheels</title>`; change `#splashvid` to `<img id="splashvid" src="/assets/brands/slopwheels.png" alt="Slopwheels">`; splash background to `#000`; progress bar/fill colors to the logo's acid green `#b6e324` (sample the exact hex from the asset before hardcoding — use any color picker on `public/assets/brands/slopwheels.png` and use THAT value in both bar and glow).

- [ ] **Step 2: Honest progress bridge**

In the inline splash script, replace the ease-to-90% timer with a stepped target the app drives, keeping the existing smoothing animation:

```js
let target = 10;                       // something moves immediately
window.setSplashProgress = (pct) => { target = Math.max(target, Math.min(pct, 99)); };
// keep the existing rAF that eases `current` toward `target` and writes #splashfill/#splashpct
// keep window.hideSplash exactly as-is (fill to 100, dwell, fade)
```

In `src/main.ts`, call the milestones at the real boot beats: after `createScene` → `window.setSplashProgress?.(30)`; after the HUD block (`createHud` etc.) → `55`; after `inventory` + `garage` construction → `75`; inside `bootIdentity()` completion path → `90`. With Task 6, home-ready calls `window.hideSplash?.()` — `createBootReveal`'s car-settle reveal (`:166–:170`) changes its `reveal:` callback to a no-op for the splash (the 20s timeout safety stays; home does the reveal).

- [ ] **Step 3: Verify in the browser**

Load `/play/` on the dev server: black splash, Slopwheels wordmark, bar advancing in visible steps, no permanent stall (timeout fallback still fires if a step never lands). Title bar reads "Slopwheels".

- [ ] **Step 4: Commit**

```bash
git add play/index.html src/main.ts
git commit -m "feat: slopwheels loadscreen with honest boot progress"
```

---

### Task 6: Home screen (`ui/home.ts`) + `"home"` boot mode

**Files:**
- Create: `src/ui/home.ts`
- Test: `src/ui/home.test.ts`
- Modify: `src/main.ts` (mode union `:930`, frame dispatcher `:1799`, boot tail `:2159–2162`, map button `:1118`)
- Run once: `npm run bake:cards` (refresh `public/cards/*.png`; commit the PNGs)

- [ ] **Step 1: Write the failing test for the pure bits**

```ts
// src/ui/home.test.ts
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
```

`cardSlug` MUST reproduce `scripts/bake-cards.mjs:87`'s slug rule — read that line and copy the exact regex chain, then bake cards and spot-check three filenames in `public/cards/` against `cardSlug(displayName)`.

- [ ] **Step 2: Run test to verify it fails, then implement `ui/home.ts`**

Run: `npx vitest run src/ui/home.test.ts` → FAIL (module missing). Then:

```ts
// src/ui/home.ts
// The Slopwheels boot surface: your collection is the game's front door.
// Pure DOM (no three.js import) — home must cost nothing on the GPU.
import type { CarOption } from "./carpicker";
import { carDisplayName } from "./carpicker";

export interface HomeDeps {
  cars: () => CarOption[];              // CAR_DEFS
  owns: (name: string) => boolean;      // inventory.owns
  equippedName: () => string;           // current equipped car
  onDriveLobby: (carName: string) => void;
  onEnterRace: (carName: string) => void;
  onWatchAndBet: () => void;
  onOpenStore: () => void;              // crateBox.open()
}
export interface Home {
  el: HTMLElement;
  show(): void;                          // (re)renders the grid from current ownership
  hide(): void;
  isOpen(): boolean;
  dispose(): void;
}

export const cardSlug = (displayName: string): string =>
  displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); // verify vs bake-cards.mjs:87

export function sortForCollection(defs: CarOption[], owns: (n: string) => boolean): CarOption[] {
  return [...defs].sort((a, b) => {
    const ao = owns(a.name) ? 1 : 0, bo = owns(b.name) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    if ((a.rarity ?? 0) !== (b.rarity ?? 0)) return (b.rarity ?? 0) - (a.rarity ?? 0);
    return a.name.localeCompare(b.name);
  });
}

export function createHome(parent: HTMLElement, deps: HomeDeps): Home {
  // Layout: fullscreen fixed panel, z below the access wall (z-index:40) and splash (50) → use 30.
  // Header: slopwheels wordmark (img /assets/brands/slopwheels.png, height ~48px) + wallet-free top bar.
  // Tab strip: [Collection] [Store]. Store tab is a passthrough → deps.onOpenStore() (cratebox is
  // its own overlay); Collection renders the card grid. Sticky footer button: [Watch & bet].
  // Card: <img src="/cards/<cardSlug(displayName)>.png" onerror→hide img, show CSS silhouette>,
  // name, rarity pips; owned cards get action row [Enter race] [Drive lobby]; unowned render dimmed
  // with a lock glyph and a [Get crates] shortcut → deps.onOpenStore().
  // Follow cratebox.ts's DOM idiom (createElement + inline styles / class strings — read how
  // cratebox builds its card rows first and mirror it; do NOT introduce a framework or innerHTML
  // templates with user data).
  // All taps use ui/tap.ts onTap (the repo's multi-touch rule) — import { onTap } from "./tap".
  /* implementation */
}
```

The comment block is the layout contract; implement to it. Buttons call deps callbacks — home knows nothing about modes.

- [ ] **Step 3: Wire the `"home"` mode into `src/main.ts`**

1. Mode union (`:930`): `let mode: "race" | "lobby" | "highway" | "garage" | "home" | "grandprix" = "race";` (grandprix used in Task 7).
2. Construct home after `crateBox` exists (`:729` block):

```ts
const home = createHome(hudRoot, {
  cars: () => CAR_DEFS,
  owns: (n) => inventory.owns(n),
  equippedName: () => equippedCar.name,
  onDriveLobby: (carName) => { equipByName(carName); exitHomeToLobby(); },
  onEnterRace: (carName) => enterGrandprix(carName),   // Task 7 lands this; stub alert until then
  onWatchAndBet: () => enterGrandprix(null),
  onOpenStore: () => crateBox.open(),
});
```
`equipByName(name)` is a tiny new helper beside `garage` (`:650`) that finds the `CarOption` and invokes the same select callback carpicker uses (`car.setModel(c.url, c.scale, c.yaw); setAbility(c.ability); carBaseLev = c.baseLev ?? 0; tach.rebuild(effRmax()); equippedCar = c; garageRoom?.setCar(c);`) — extract that existing callback body into `equipByName` and have BOTH carpicker's `onSelect` and home call it (DRY, single equip path).
3. Mode fns beside `enterLobby` (`:970`):

```ts
function enterHome(): void {
  if (modeSwitchBlocked({ opening, phase: engine.getPhase() })) return;
  mode = "home";
  lobbyHud.hide(); home.show();
  window.hideSplash?.();          // home-ready IS boot-ready
}
function exitHomeToLobby(): void { home.hide(); ensureWorlds(); enterLobby(); }
```
4. Frame dispatcher (`:1799`): add before the lobby branch:

```ts
if (mode === "home") { requestAnimationFrame(frame); return; } // no 3D render while home is up
```
5. Boot tail (`:2162`): replace `enterLobby();` with `enterHome();`.
6. Map/back button (`:1118`): lobby now goes home — extend the handler: `else if (mode === "lobby") enterHome();` (keep existing branches; read the current handler and slot this in without breaking highway/garage returns).
7. `crateBox` `onClose` (`:775`): add home: `if (mode === "lobby") lobbyHud.show(); else if (mode === "home") home.show();`
8. `ensureWorlds()` for now is `function ensureWorlds(): void {}` — Task 8 gives it a body. Place it near the top of the mode functions with a comment saying Task 8 fills it.

- [ ] **Step 4: Refresh card art**

Run: `npm run bake:cards`
Expected: writes `public/cards/*.png` for the current roster. Spot-check three slugs match `cardSlug`. Commit the PNGs with this task.

- [ ] **Step 5: Tests + browser verification**

Run: `npx vitest run && npx tsc --noEmit` → green.
Browser (`/play/`, localhost = DEV_UNLOCK bypasses the wall): splash → home appears with card grid (owned + silhouettes), Store tab opens the crate shop and returns to home on close, [Drive lobby] equips + lands in the town, map button in the lobby returns home, perps modes still reachable from lobby buildings, style toggle still works. Screenshot home for the record.

- [ ] **Step 6: Commit**

```bash
git add src/ui/home.ts src/ui/home.test.ts src/main.ts public/cards
git commit -m "feat: slopwheels collection home as boot mode"
```

---

### Task 7: `"grandprix"` in-app race mode

**Files:**
- Modify: `src/main.ts` (new mode functions + frame branch; `__hw` dev hook `:2366`)
- Reference: Task 4's `RaceGame` surface; Task 1/2 cores

- [ ] **Step 1: Podium credit inside race-mode.ts, navigation in main.ts**

Split of responsibility (final, no alternatives): race-mode.ts OWNS the podium credit so the player sees it on the FINISH screen; main.ts only navigates.

In `src/render/race-mode.ts`, `enterFinish` becomes:

```ts
import { ownerPodiumPayout } from "../core/race-payout";
// ... inside enterFinish():
const finishOrder = order();
const playerIdx = grid.findIndex((g) => g.isPlayer);
const playerRank = playerIdx >= 0 ? finishOrder.indexOf(playerIdx) : null;
lastResult = { finishOrder, playerRank, poolTotal: betPanel.poolTotal() };
betPanel.settle(finishOrder[0]);
if (playerRank !== null) {
  const pay = ownerPodiumPayout(lastResult.poolTotal, playerRank);
  if (pay > 0) betPanel.credit(pay, `Podium — P${playerRank + 1}`);
}
```

When `opts.onExit` is set (in-app only, harness passes none), race-mode.ts adds a "Done" button to the FINISH results row (same DOM idiom as the panel's RACE AGAIN button) that calls `opts.onExit(lastResult)`.

Beside the other mode fns in `src/main.ts`:

```ts
import { createRaceGame, mulberry32, type RaceGame } from "./render/race-mode";
import { buildGrid } from "./core/race-grid";

let raceGame: RaceGame | null = null;

function enterGrandprix(playerCarName: string | null): void {
  if (modeSwitchBlocked({ opening, phase: engine.getPhase() })) return;
  mode = "grandprix";
  home.hide(); lobbyHud.hide();
  const seed = (Math.random() * 1e9) >>> 0;
  raceGame = createRaceGame({
    scene: ctx.scene, camera: ctx.camera, hudParent: hudRoot,
    grid: buildGrid(CAR_DEFS.filter((c) => !c.locked || inventory.owns(c.name)), playerCarName, mulberry32(seed)),
    seed, lowTier: quality.detail !== "full",
    onExit: () => exitGrandprixToHome(),
  });
}
function exitGrandprixToHome(): void {
  raceGame?.dispose(); raceGame = null;
  mode = "home"; home.show();
}
```

(`mulberry32` moves into race-mode.ts in Task 4 and is exported from there — Task 4's surface includes `export function mulberry32(seed: number): () => number`.)

- [ ] **Step 2: Frame branch**

In `frame()` (`:1799`), after the home branch:

```ts
if (mode === "grandprix") {
  const dt = clampedDt;   // reuse the loop's existing dt variable — read frame() and use ITS name
  raceGame?.update(dt);
  ctx.renderer/composer render — mirror how the lobby branch ends a frame (post pipeline or direct render), then:
  requestAnimationFrame(frame); return;
}
```
The render call is deliberately spelled out as "mirror the lobby branch": read `frame()`'s lobby branch end (`:1815–:1881`) and use the identical render path (post composer when enabled, plain `ctx.renderer.render` otherwise). Do not hand-roll a new one.

- [ ] **Step 3: Sim test for podium credit**

Append to `src/render/race-mode.test.ts`:

```ts
it("credits the podium owner in the results when the player's car places", () => {
  // grid with the player car guaranteed strongest → rank 0 with overwhelming probability
  const grid = DEFAULT_GRID.map((g, i) => ({ ...g, isPlayer: i === 0, strength: i === 0 ? 99 : 1 }));
  const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const hudParent = document.createElement("div");
  const game = createRaceGame({ scene, camera, hudParent, grid, seed: 3, lowTier: true, onExit: () => {} });
  for (let t = 0; t < 300 && game.phase() !== "FINISH"; t += 1 / 30) game.update(1 / 30);
  expect(game.phase()).toBe("FINISH");
  expect(hudParent.textContent).toContain("Podium — P1");
  game.dispose();
});
```

Run: `npx vitest run src/render/race-mode.test.ts` → the new test FAILS before the race-mode.ts change, PASSES after.

- [ ] **Step 4: Dev hook + suite**

Add to `__hw` (`:2366`): `enterGrandprix, exitGrandprixToHome,` so the browser check can jump straight in.
Run: `npx vitest run && npx tsc --noEmit` → green.

- [ ] **Step 5: Browser verification**

`/play/` on localhost: from home, [Enter race] on an owned car → race scene mounts inside the app (no page change), betting works, race runs, FINISH shows settlement + "Podium — P<n>" when placed, Done returns to home, re-entering works (no leak: `window.__hw.gfx.renderer.info.memory` geometries/textures return to ~pre-race counts after Done — record the numbers). [Watch & bet] runs an all-house race with betting only. Perps road untouched: enter highway from lobby, drive, return.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/render/race-mode.ts src/render/race-mode.test.ts
git commit -m "feat: grandprix in-app race mode with owner podium"
```

---

### Task 8: Defer heavy world construction (`ensureWorlds`)

**Files:**
- Modify: `src/main.ts` (relocate the eager blocks; the two knots below)

The blocks that move inside `ensureWorlds()` (memoized, first call builds): `createWorld` block (`:142–:163`), `createLobby` + scene add (`:786–:790`), strip dressing (`:801–:841`), `createLobbyCam`/`createOval`/`createGarageRoom` (`:845–:893`), `precompileModes()` call (`:2159`). `createScene`, `createCar`, HUD, session, inventory, carpicker, cratebox, home stay eager (DOM/cheap; the car GLB is async anyway and its group renders nothing while home skips rendering).

**Knot 1 (`:597`):** `levels = createInventory("redline.levels.v1", [world.currentTheme()])` runs before `world` would now exist. Replace with the persisted-key read: `import { loadThemeKey } from "./render/world-themes";` → `createInventory("redline.levels.v1", [loadThemeKey()])`. Verify `loadThemeKey` is exported from `src/render/world-themes.ts` (the scout confirmed `world.ts` imports it from there); if its default differs from `world.currentTheme()`'s boot value, read both and reconcile — the invariant is: the booted theme is owned (`main.ts:596` comment).

**Knot 2:** module-level references to `world`/`lobby`/`oval`/`garageRoom` outside the moved blocks (e.g. `setWorldTheme` + `__skin` hook `:151–:163`, `triggerBuilding` cases, highway restore `:1362`). Pattern: declare `let world: World | null = null;` etc.; `ensureWorlds()` assigns them; every outside reference either (a) already runs only after a mode entry that calls `ensureWorlds()` (`exitHomeToLobby`, highway restore — ADD `ensureWorlds()` at the top of `enterHighway` when `restoring`), or (b) gets an optional-chain (`world?.`) with a comment naming the mode guarantee. `tsc --noEmit` is the enforcement tool here: make the types nullable and let the compiler list every touch point; fix each deliberately, no blanket non-null assertions.

- [ ] **Step 1: Apply the move + knots; get `tsc --noEmit` clean**
- [ ] **Step 2: Full suite**

Run: `npx vitest run` → green (main.ts has no direct unit tests; the suite guards the modules it imports).

- [ ] **Step 3: Browser verification — the actual point of this task**

`/play/` localhost, throttled network (dev tools, "Fast 3G") for honesty:
- Boot → home with NO world built: in console, `window.__hw.gfx.scene.children.length` small (record before/after), `window.__hw.gfx.renderer.info.memory.geometries` a fraction of pre-task numbers (record both).
- [Drive lobby] → first entry builds the town (expect a beat — loading affordance is the existing splash-free UI; acceptable for demo), everything works: buildings, crates, garage showroom, highway/track entry, theme switch (`window.__skin`), style toggle.
- Return home → re-enter lobby: instant (memoized, no rebuild).
- Race from home before ever visiting the lobby: works (grandprix never needs the world).
- bfcache/back-forward: navigate away and back — no crash, home shows.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "perf: defer world/lobby/oval/garage construction until first 3D entry"
```

---

### Task 9: End-to-end proof + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-07-24-slopwheels-gacha-home-design.md` (mark shipped, note deviations)

- [ ] **Step 1: Full gates**

Run: `npx vitest run && npx tsc --noEmit` → green. `npm run build` → clean production build (race-mode must not accidentally pull dev-only harness imports; the build fails loudly if `race-preview.ts` leaks into the `play` input).

- [ ] **Step 2: The demo loop, recorded**

One unbroken browser session on `/play/`: splash (Slopwheels) → home → Store → pull a crate → new car card appears owned → [Enter race] with THAT car → bet on it → race → FINISH shows bet settlement to the cent + podium line if placed → Done → home → [Drive lobby] → town intact → map → home. Screenshot each beat; verify wallet arithmetic by hand against `RAKE`/`PODIUM_SPLIT` from `core/race-payout.ts` and paste the numbers into the task journal.

- [ ] **Step 3: Spec update + final commit**

Append an "Implemented 2026-XX-XX" section to the spec listing the two deviations (inline splash loadscreen; baked-PNG card art) and the mode name `grandprix`. Commit:

```bash
git add docs/superpowers/specs/2026-07-24-slopwheels-gacha-home-design.md
git commit -m "docs: mark slopwheels home spec implemented"
```

---

## Task ordering & independence

1 → 2 → 3 are independent pure-logic tasks (any order, no shared files).
4 depends on 2 (GridEntrant) and 3 (credit, used by finish flow in 7's refinement — implement panel credit before extraction lands its FINISH wiring).
5 is independent of everything except main.ts merge conflicts — schedule before 6.
6 depends on 5 (hideSplash handoff) and 4 only via the `enterGrandprix` stub note (home can land with the race button stubbed).
7 depends on 4 + 6. 8 depends on 6 (ensureWorlds callers) and should land after 7 so its browser check covers racing-without-lobby. 9 is last.
Workers on different tasks must not touch `src/main.ts` concurrently — tasks 5, 6, 7, 8 each modify it; run them sequentially.
