# Redline 3D Client — Implementation Plan (Phase 0 + Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new `redline3d/` project: a headless, fully-tested game core ported from the working 2D prototype (Phase 0), then a playable true-3D neon-synthwave render + HUD wired to that core (Phase 1).

**Architecture:** "Evolve core, rebuild shell." `src/core/` is pure, headless TypeScript (no DOM/WebGL) — the economics + round FSM + price feed, unit-tested against golden values taken from `prototype/redline.html`. `src/render/` (Three.js) and `src/ui/` (DOM overlay) subscribe to core state. `src/platform/` isolates web-vs-Seeker behind interfaces. The client is real-money-ready via a `Settlement` seam (`SimSettlement` now, `VaultSettlement` later) but ships on the sim this pass.

**Tech Stack:** TypeScript, Vite (dev/build + HMR), Vitest (unit tests), Three.js (WebGL2). Capacitor/PWA are Phase 3 (a later plan).

**Scope note:** This plan covers **Phase 0 (foundation)** and **Phase 1 (playable 3D)** from the spec (`docs/superpowers/specs/2026-06-18-redline-3d-seeker-design.md`). Phase 2 (feel: 3D cinematics, audio, haptics, perf tiering) and Phase 3 (Seeker packaging) each get their own plan after Phase 1 lands. Work happens on branch `redline-3d`, in a new `redline3d/` subdirectory (the existing `prototype/` stays intact as the reference).

**Source of truth for the port:** `prototype/redline.html` (economics at lines 133–135, 147–150, 341–371, 392–425, 430–438) and `prototype/feed.js`. Golden values in the tests below were computed from those formulas.

---

## File structure (created by this plan)

```
redline3d/
  package.json · tsconfig.json · vite.config.ts · index.html
  src/
    core/
      types.ts          shared interfaces (Dir, Phase, Snapshot, …)
      config.ts         CONFIG constants (EDGE, LIQ, CAP, MAXSEC, leverage range)
      leverage.ts       tToLev / niceLev / levFrac  (+ test)
      economics.ts      equity / payout / profit / liqPrice / buffer / rebank (+ test)
      settlement.ts     Settlement interface + SimSettlement (+ test)
      round.ts          RoundEngine FSM (+ test)
      feed.ts           ported Pyth transport (Lazer→Hermes) from prototype/feed.js
      price-source.ts   feed + sim + staleness → single price stream (+ test)
    render/
      scene.ts          renderer, scene graph, render loop
      world.ts          ground grid + sky + sun + scrolling road
      car.ts            procedural low-poly car, equity color
      camera.ts         chase cam, risk-driven speed/FOV
      post.ts           bloom (perf-gated)
    ui/
      hud.ts            balance / multiplier / status / liq buffer (DOM overlay)
      tach.ts           leverage tach control (SVG)
      controls.ts       long/short, stake, LAUNCH/CASH-OUT, keyboard
    platform/
      perf.ts           device-tier detection + quality flags
    main.ts             bootstrap: wires core → render → ui → platform
```

---

# PHASE 0 — Headless core (full TDD)

## Task 0: Project scaffold & tooling

**Files:**
- Create: `redline3d/package.json`
- Create: `redline3d/tsconfig.json`
- Create: `redline3d/vite.config.ts`
- Create: `redline3d/index.html` (placeholder, replaced in Phase 1)
- Create: `redline3d/src/main.ts` (placeholder)

- [ ] **Step 1: Create the project directory and `package.json`**

Create `redline3d/package.json`:

```json
{
  "name": "redline3d",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  },
  "dependencies": {
    "three": "^0.169.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Create `redline3d/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"],
    "lib": ["ES2020", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vite.config.ts`**

Create `redline3d/vite.config.ts`:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  test: { globals: true, environment: "node" },
  build: { target: "es2020" },
});
```

- [ ] **Step 4: Create placeholder `index.html` and `src/main.ts`**

Create `redline3d/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
    <title>REDLINE 3D</title>
  </head>
  <body>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Create `redline3d/src/main.ts`:

```ts
console.log("redline3d boot");
```

- [ ] **Step 5: Install dependencies and verify tooling**

Run: `cd redline3d && npm install`
Expected: installs with no errors; `node_modules/` present.

Run: `cd redline3d && npm run test`
Expected: Vitest runs and reports "No test files found" (exit non-zero is OK at this point) — confirms Vitest is wired.

- [ ] **Step 6: Create `.gitignore` and commit**

Create `redline3d/.gitignore`:

```
node_modules
dist
*.local
```

```bash
git add redline3d/package.json redline3d/package-lock.json redline3d/tsconfig.json redline3d/vite.config.ts redline3d/index.html redline3d/src/main.ts redline3d/.gitignore
git commit -m "chore: scaffold redline3d (vite + ts + vitest + three)"
```

---

## Task 1: Core types & config

**Files:**
- Create: `redline3d/src/core/types.ts`
- Create: `redline3d/src/core/config.ts`

- [ ] **Step 1: Create `types.ts`**

```ts
export type Dir = 1 | -1;
export type Phase = "idle" | "live" | "settled" | "liquidated";
export type SettleReason = "cashout" | "cap" | "time" | "liq";

export interface Position {
  dir: Dir;
  lev: number;
  /** raw price at the current anchor (re-anchored on leverage change) */
  entryRaw: number;
  /** realized/locked gains from prior segments */
  banked: number;
}

export interface Snapshot {
  phase: Phase;
  equity: number;
  payout: number;
  /** liquidation buffer 0..1 */
  buffer: number;
  banked: number;
  lev: number;
  reason?: SettleReason;
}
```

- [ ] **Step 2: Create `config.ts`**

These values are copied verbatim from `prototype/redline.html` lines 134 and 147.

```ts
export const CONFIG = {
  EDGE: 0.05,      // house edge baked into payout
  LIQ: 0.2,        // equity <= LIQ → liquidated
  CAP: 25,         // equity >= CAP → max-payout settle
  MAXSEC: 60,      // time cap (seconds)
  RMIN: 10,        // min leverage
  RMAX: 1000,      // max leverage
  REDLINE: 400,    // redline leverage threshold
  START_BALANCE: 100,
  MIN_STAKE: 1,
  MAX_STAKE: 50,
} as const;
```

- [ ] **Step 3: Commit**

```bash
git add redline3d/src/core/types.ts redline3d/src/core/config.ts
git commit -m "feat(core): shared types and config constants"
```

---

## Task 2: Leverage math

The leverage dial maps a 0–100 throttle to a discrete leverage value. From `prototype/redline.html` lines 148–150.

**Files:**
- Create: `redline3d/src/core/leverage.ts`
- Test: `redline3d/src/core/leverage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `redline3d/src/core/leverage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { levFrac, tToLev, niceLev } from "./leverage";

describe("leverage", () => {
  it("levFrac maps RMIN→0, RMAX→1", () => {
    expect(levFrac(10)).toBeCloseTo(0, 6);
    expect(levFrac(1000)).toBeCloseTo(1, 6);
    expect(levFrac(400)).toBeCloseTo(0.8011, 3);
  });

  it("tToLev maps throttle 0→10, 100→1000", () => {
    expect(tToLev(0)).toBeCloseTo(10, 6);
    expect(tToLev(100)).toBeCloseTo(1000, 6);
    expect(tToLev(34)).toBeCloseTo(47.867, 2);
  });

  it("niceLev rounds by band", () => {
    expect(niceLev(47.867)).toBe(50);   // <100 → nearest 5
    expect(niceLev(123)).toBe(120);     // <500 → nearest 10
    expect(niceLev(777)).toBe(800);     // >=500 → nearest 50
    expect(niceLev(1000)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd redline3d && npx vitest run src/core/leverage.test.ts`
Expected: FAIL — "Failed to resolve import './leverage'".

- [ ] **Step 3: Write minimal implementation**

Create `redline3d/src/core/leverage.ts`:

```ts
import { CONFIG } from "./config";

const { RMIN, RMAX } = CONFIG;

/** position of leverage l on a log scale, 0 at RMIN, 1 at RMAX */
export function levFrac(l: number): number {
  return Math.log(l / RMIN) / Math.log(RMAX / RMIN);
}

/** throttle 0..100 → leverage on a log curve */
export function tToLev(t: number): number {
  return RMIN * Math.pow(RMAX / RMIN, t / 100);
}

/** snap a raw leverage to a "nice" discrete value */
export function niceLev(l: number): number {
  if (l < 100) return Math.round(l / 5) * 5;
  if (l < 500) return Math.round(l / 10) * 10;
  return Math.round(l / 50) * 50;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd redline3d && npx vitest run src/core/leverage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/leverage.ts redline3d/src/core/leverage.test.ts
git commit -m "feat(core): leverage math (tToLev/niceLev/levFrac) with tests"
```

---

## Task 3: Economics

The heart of the game. Pure functions implementing the **LINEAR-from-entry** P&L (the verified vol-independent model — must not regress). From `prototype/redline.html` lines 352–353, 360, 303, 435.

**Files:**
- Create: `redline3d/src/core/economics.ts`
- Test: `redline3d/src/core/economics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `redline3d/src/core/economics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CONFIG } from "./config";
import { equityOf, payoutOf, profitOf, liqPriceOf, bufferOf, rebank } from "./economics";
import type { Position } from "./types";

const base: Position = { dir: 1, lev: 10, entryRaw: 100, banked: 0 };

describe("economics", () => {
  it("equity is linear from entry: 1 + banked + dir*lev*(price/entry - 1)", () => {
    expect(equityOf(base, 100)).toBeCloseTo(1, 6);
    expect(equityOf(base, 101)).toBeCloseTo(1.1, 6); // 10 * 0.01 = 0.1
    expect(equityOf({ ...base, dir: -1 }, 99)).toBeCloseTo(1.1, 6);
  });

  it("equity is clamped at 0", () => {
    expect(equityOf({ ...base, lev: 50 }, 98)).toBe(0); // 50*(-0.02) = -1 → clamp
  });

  it("equity includes banked gains", () => {
    expect(equityOf({ ...base, banked: 1 }, 101)).toBeCloseTo(2.1, 6);
  });

  it("payout applies the house edge", () => {
    expect(payoutOf(1, 1.1, CONFIG.EDGE)).toBeCloseTo(1.045, 6); // 1 * 1.1 * 0.95
    expect(payoutOf(2, 1.0, CONFIG.EDGE)).toBeCloseTo(1.9, 6);
  });

  it("payout floors equity at 0", () => {
    expect(payoutOf(1, -3, CONFIG.EDGE)).toBe(0);
  });

  it("profit = payout - stake", () => {
    expect(profitOf(1, 1.045)).toBeCloseTo(0.045, 6);
  });

  it("liqPrice is where a long/short hits the LIQ threshold", () => {
    // dir 1, lev 50, entry 100, LIQ 0.2 → 100*(1 - 0.8/50) = 98.4
    expect(liqPriceOf(100, 1, 50, CONFIG.LIQ)).toBeCloseTo(98.4, 6);
    expect(liqPriceOf(100, -1, 50, CONFIG.LIQ)).toBeCloseTo(101.6, 6);
  });

  it("buffer is 1 at/above entry, 0 at LIQ", () => {
    expect(bufferOf(1.5, CONFIG.LIQ)).toBe(1);
    expect(bufferOf(0.6, CONFIG.LIQ)).toBeCloseTo(0.5, 6); // (0.6-0.2)/0.8
    expect(bufferOf(0.2, CONFIG.LIQ)).toBe(0);
    expect(bufferOf(0.1, CONFIG.LIQ)).toBe(0);
  });

  it("rebank realizes the current segment and re-anchors entry", () => {
    const r = rebank({ ...base }, 110); // 10*(110/100-1) = 1.0
    expect(r.banked).toBeCloseTo(1, 6);
    expect(r.entryRaw).toBe(110);
    // after rebank, equity continues from the new anchor
    expect(equityOf(r, 110)).toBeCloseTo(2, 6); // 1 + 1 + 0
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd redline3d && npx vitest run src/core/economics.test.ts`
Expected: FAIL — "Failed to resolve import './economics'".

- [ ] **Step 3: Write minimal implementation**

Create `redline3d/src/core/economics.ts`:

```ts
import type { Position } from "./types";

/** LINEAR-from-entry equity (vol-independent). entryRaw is the raw price anchor. */
export function equityOf(pos: Position, price: number): number {
  if (!(pos.entryRaw > 0)) return 1;
  const eq = 1 + pos.banked + pos.dir * pos.lev * (price / pos.entryRaw - 1);
  return eq < 0 ? 0 : eq;
}

export function payoutOf(stake: number, equity: number, edge: number): number {
  return stake * Math.max(0, equity) * (1 - edge);
}

export function profitOf(stake: number, payout: number): number {
  return payout - stake;
}

/** price at which equity hits the liq threshold (for the chart line) */
export function liqPriceOf(entryPx: number, dir: number, lev: number, liq: number): number {
  return entryPx * (1 - dir * (1 - liq) / lev);
}

/** liquidation buffer: 1 at/above entry, 0 at LIQ */
export function bufferOf(equity: number, liq: number): number {
  if (equity >= 1) return 1;
  return Math.max(0, (equity - liq) / (1 - liq));
}

/** realize the current segment into banked and re-anchor entry to the current price */
export function rebank(pos: Position, price: number): Position {
  if (!(pos.entryRaw > 0)) return pos;
  return {
    ...pos,
    banked: pos.banked + pos.dir * pos.lev * (price / pos.entryRaw - 1),
    entryRaw: price,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd redline3d && npx vitest run src/core/economics.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/economics.ts redline3d/src/core/economics.test.ts
git commit -m "feat(core): LINEAR-from-entry economics with golden-value tests"
```

---

## Task 4: Settlement seam (SimSettlement)

The money seam. `SimSettlement` holds a local balance; `VaultSettlement` (later plan) will make it server-authoritative without changing this interface.

**Files:**
- Create: `redline3d/src/core/settlement.ts`
- Test: `redline3d/src/core/settlement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `redline3d/src/core/settlement.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SimSettlement } from "./settlement";
import { CONFIG } from "./config";

describe("SimSettlement", () => {
  it("starts at START_BALANCE", () => {
    expect(new SimSettlement().balance()).toBe(CONFIG.START_BALANCE);
  });

  it("canAfford respects balance", () => {
    const s = new SimSettlement(1.5);
    expect(s.canAfford(1)).toBe(true);
    expect(s.canAfford(2)).toBe(false);
  });

  it("debit then credit moves the balance", () => {
    const s = new SimSettlement(100);
    s.debit(1);
    expect(s.balance()).toBe(99);
    s.credit(1.045);
    expect(s.balance()).toBeCloseTo(100.045, 6);
  });

  it("debit throws if unaffordable", () => {
    expect(() => new SimSettlement(0.5).debit(1)).toThrow();
  });

  it("reset returns to START_BALANCE", () => {
    const s = new SimSettlement(3);
    s.reset();
    expect(s.balance()).toBe(CONFIG.START_BALANCE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd redline3d && npx vitest run src/core/settlement.test.ts`
Expected: FAIL — "Failed to resolve import './settlement'".

- [ ] **Step 3: Write minimal implementation**

Create `redline3d/src/core/settlement.ts`:

```ts
import { CONFIG } from "./config";

export interface Settlement {
  balance(): number;
  canAfford(stake: number): boolean;
  debit(stake: number): void; // on launch
  credit(payout: number): void; // on settle
  reset(): void;
}

export class SimSettlement implements Settlement {
  private bal: number;
  constructor(initial: number = CONFIG.START_BALANCE) {
    this.bal = initial;
  }
  balance(): number {
    return this.bal;
  }
  canAfford(stake: number): boolean {
    return this.bal >= stake;
  }
  debit(stake: number): void {
    if (!this.canAfford(stake)) throw new Error("insufficient balance");
    this.bal -= stake;
  }
  credit(payout: number): void {
    this.bal += payout;
  }
  reset(): void {
    this.bal = CONFIG.START_BALANCE;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd redline3d && npx vitest run src/core/settlement.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/settlement.ts redline3d/src/core/settlement.test.ts
git commit -m "feat(core): Settlement interface + SimSettlement with tests"
```

---

## Task 5: RoundEngine (FSM)

Ties economics + leverage into the round lifecycle: `idle → live → (settled | liquidated)`. Mirrors the loop logic in `prototype/redline.html` lines 351–371, 392–425, 435.

**Files:**
- Create: `redline3d/src/core/round.ts`
- Test: `redline3d/src/core/round.test.ts`

- [ ] **Step 1: Write the failing test**

Create `redline3d/src/core/round.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RoundEngine } from "./round";

function launched(lev = 10) {
  const r = new RoundEngine();
  r.launch({ dir: 1, lev, stake: 1, entryRaw: 100, startMs: 0 });
  return r;
}

describe("RoundEngine", () => {
  it("starts idle", () => {
    expect(new RoundEngine().snapshot(100, 0).phase).toBe("idle");
  });

  it("launch → live; equity tracks price", () => {
    const r = launched();
    const s = r.tick(101, 1000);
    expect(s.phase).toBe("live");
    expect(s.equity).toBeCloseTo(1.1, 6);
  });

  it("liquidates when equity <= LIQ", () => {
    const r = launched(50);
    const s = r.tick(98, 1000); // equity → 0
    expect(s.phase).toBe("liquidated");
    expect(s.reason).toBe("liq");
    expect(s.payout).toBe(0);
  });

  it("caps at CAP and settles", () => {
    const r = launched(1000);
    const s = r.tick(105, 1000); // equity huge → cap
    expect(s.phase).toBe("settled");
    expect(s.reason).toBe("cap");
    expect(s.equity).toBe(25); // CONFIG.CAP
  });

  it("settles on time cap", () => {
    const r = launched();
    const s = r.tick(101, 60_000); // elapsed >= MAXSEC
    expect(s.phase).toBe("settled");
    expect(s.reason).toBe("time");
  });

  it("cashout settles with reason cashout", () => {
    const r = launched();
    r.tick(102, 1000);
    const s = r.cashout(102, 1500);
    expect(s.phase).toBe("settled");
    expect(s.reason).toBe("cashout");
    expect(s.payout).toBeCloseTo(1 * 1.2 * 0.95, 6); // equity 1.2, edge 0.05
  });

  it("setLeverage banks the current segment and re-anchors", () => {
    const r = launched(10);
    r.tick(110, 1000); // equity 2.0 at this point
    r.setLeverage(20, 110);
    const s = r.tick(110, 1100);
    // banked = 1.0; new segment 0 → equity 2.0; lev now 20
    expect(s.lev).toBe(20);
    expect(s.equity).toBeCloseTo(2, 6);
  });

  it("ignores ticks after settle", () => {
    const r = launched();
    r.cashout(102, 1500);
    const s = r.tick(200, 2000);
    expect(s.phase).toBe("settled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd redline3d && npx vitest run src/core/round.test.ts`
Expected: FAIL — "Failed to resolve import './round'".

- [ ] **Step 3: Write minimal implementation**

Create `redline3d/src/core/round.ts`:

```ts
import { CONFIG } from "./config";
import type { Dir, Phase, SettleReason, Position, Snapshot } from "./types";
import { equityOf, payoutOf, bufferOf, rebank } from "./economics";

export interface LaunchParams {
  dir: Dir;
  lev: number;
  stake: number;
  entryRaw: number;
  startMs: number;
}

export class RoundEngine {
  private phase: Phase = "idle";
  private pos: Position = { dir: 1, lev: 10, entryRaw: 0, banked: 0 };
  private stake = 0;
  private startMs = 0;
  private reason?: SettleReason;
  private finalEquity = 1;

  getPhase(): Phase {
    return this.phase;
  }

  launch(p: LaunchParams): void {
    this.phase = "live";
    this.pos = { dir: p.dir, lev: p.lev, entryRaw: p.entryRaw, banked: 0 };
    this.stake = p.stake;
    this.startMs = p.startMs;
    this.reason = undefined;
    this.finalEquity = 1;
  }

  /** realize the current segment and re-anchor; called when the throttle moves mid-run */
  setLeverage(newLev: number, price: number): void {
    if (this.phase !== "live") return;
    if (newLev === this.pos.lev) return;
    this.pos = { ...rebank(this.pos, price), lev: newLev };
  }

  /** advance the round; auto-settles on liq/cap/time */
  tick(price: number, nowMs: number): Snapshot {
    if (this.phase !== "live") return this.snapshot(price, nowMs);
    const equity = equityOf(this.pos, price);
    if (equity <= CONFIG.LIQ) return this.finish("liquidated", "liq", 0);
    if (equity >= CONFIG.CAP) return this.finish("settled", "cap", CONFIG.CAP);
    if ((nowMs - this.startMs) / 1000 >= CONFIG.MAXSEC)
      return this.finish("settled", "time", equity);
    return this.snapshot(price, nowMs);
  }

  cashout(price: number, nowMs: number): Snapshot {
    if (this.phase !== "live") return this.snapshot(price, nowMs);
    return this.finish("settled", "cashout", equityOf(this.pos, price));
  }

  private finish(phase: Phase, reason: SettleReason, equity: number): Snapshot {
    this.phase = phase;
    this.reason = reason;
    this.finalEquity = equity;
    return {
      phase,
      equity,
      payout: payoutOf(this.stake, equity, CONFIG.EDGE),
      buffer: bufferOf(equity, CONFIG.LIQ),
      banked: this.pos.banked,
      lev: this.pos.lev,
      reason,
    };
  }

  snapshot(price: number, _nowMs: number): Snapshot {
    if (this.phase === "idle")
      return { phase: "idle", equity: 1, payout: 0, buffer: 1, banked: 0, lev: this.pos.lev };
    const equity = this.phase === "live" ? equityOf(this.pos, price) : this.finalEquity;
    return {
      phase: this.phase,
      equity,
      payout: payoutOf(this.stake, equity, CONFIG.EDGE),
      buffer: bufferOf(equity, CONFIG.LIQ),
      banked: this.pos.banked,
      lev: this.pos.lev,
      reason: this.reason,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd redline3d && npx vitest run src/core/round.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/round.ts redline3d/src/core/round.test.ts
git commit -m "feat(core): RoundEngine FSM (launch/tick/cashout/setLeverage) with tests"
```

---

## Task 6: Price source (feed port + sim + staleness)

Port the Pyth transport from `prototype/feed.js` into a typed module, then wrap it with the sim-fallback + staleness logic (from `prototype/redline.html` lines 137–143) so the game always has a price.

**Files:**
- Create: `redline3d/src/core/feed.ts`
- Create: `redline3d/src/core/price-source.ts`
- Test: `redline3d/src/core/price-source.test.ts`

- [ ] **Step 1: Port `feed.js` → `feed.ts`**

Copy `prototype/feed.js` into `redline3d/src/core/feed.ts`, then make exactly these changes:
1. Replace the wrapper `window.PythPro = (function () { … })();` with a module: delete the `window.PythPro =` assignment and the outer IIFE; keep the inner `connect` function and the `config` helper; at the bottom replace `return { connect, config };` with named exports.
2. Add types at the top and export `connectFeed`:

```ts
export interface FeedSpec { key: string; lz: number; hx: string; expo: number; }
export interface FeedStatus { source: string; live: boolean; rate: number; label: string; }
export interface FeedOpts {
  feeds: FeedSpec[];
  onPrice: (key: string, price: number, tsUs?: number) => void;
  onStatus?: (s: FeedStatus) => void;
}
export interface FeedHandle { state: FeedStatus; stop: () => void; }

export function connectFeed(opts: FeedOpts): FeedHandle { /* body = the old connect() */ }
```

3. Keep the Lazer→Hermes logic byte-for-byte inside `connectFeed`. Keep the burner-token handling but add this comment above `LAZER_TOKEN`:

```ts
// SECURITY: burner token, ships in the bundle (parity with prototype). Before any
// public release move it server-side via the relay (see spec §7 / lazer-relay.mjs).
```

4. Replace `var`→`const`/`let` only where TypeScript's `strict` complains; do not restructure logic.

Run: `cd redline3d && npx tsc --noEmit`
Expected: no type errors in `feed.ts` (fix only type annotations, never logic).

- [ ] **Step 2: Write the failing test for the price source**

Create `redline3d/src/core/price-source.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPriceSource } from "./price-source";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("price source", () => {
  it("exposes the last real price and marks live", () => {
    const ps = createPriceSource({ connect: (cb) => { cb(172.5); return () => {}; } });
    expect(ps.price()).toBe(172.5);
    expect(ps.live()).toBe(true);
  });

  it("drifts via sim when no tick arrives past the stale window", () => {
    const ps = createPriceSource({ connect: () => () => {}, staleMs: 2500, simSeed: 172 });
    expect(ps.live()).toBe(false);
    const first = ps.price();
    vi.advanceTimersByTime(1000); // sim interval fires (200ms) several times
    expect(ps.price()).not.toBe(first); // moved
    expect(ps.price()).toBeGreaterThan(0);
  });

  it("goes stale if real ticks stop", () => {
    let emit: ((p: number) => void) | null = null;
    const ps = createPriceSource({ connect: (cb) => { emit = cb; return () => {}; }, staleMs: 2500 });
    emit!(172);
    expect(ps.live()).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(ps.live()).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd redline3d && npx vitest run src/core/price-source.test.ts`
Expected: FAIL — "Failed to resolve import './price-source'".

- [ ] **Step 4: Write minimal implementation**

Create `redline3d/src/core/price-source.ts`. The `connect` dependency is injected so the staleness/sim logic is testable without a real network; the production wiring passes a `connect` that uses `connectFeed`.

```ts
export interface PriceTransport {
  /** subscribe to real prices; return an unsubscribe fn */
  connect: (onPrice: (price: number) => void) => () => void;
  staleMs?: number;
  simSeed?: number;
}

export interface PriceSource {
  price(): number;
  live(): boolean;
  stop(): void;
}

export function createPriceSource(t: PriceTransport): PriceSource {
  const staleMs = t.staleMs ?? 2500;
  let target = t.simSeed ?? 0;
  let last = 0; // timestamp of last real tick
  const now = () => Date.now();

  const unsub = t.connect((p) => {
    if (p > 0) {
      target = p;
      last = now();
    }
  });

  // sim drift + staleness backstop (mirrors prototype redline.html line 143)
  const sim = setInterval(() => {
    if (now() - last > staleMs) {
      if (!target) target = 172;
      target = Math.max(1, target * (1 + (Math.random() - 0.5) * 0.0018));
    }
  }, 200);

  return {
    price: () => target,
    live: () => now() - last <= staleMs && last > 0,
    stop: () => {
      clearInterval(sim);
      unsub();
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd redline3d && npx vitest run src/core/price-source.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the whole core suite + commit**

Run: `cd redline3d && npm run test`
Expected: PASS — all Phase 0 suites green (leverage, economics, settlement, round, price-source).

```bash
git add redline3d/src/core/feed.ts redline3d/src/core/price-source.ts redline3d/src/core/price-source.test.ts
git commit -m "feat(core): port Pyth feed transport + tested price source (sim/staleness)"
```

**Phase 0 complete — the trusted game core is ported, headless, and fully tested.**

---

# PHASE 1 — Playable 3D (build + visual verification)

> Phase 1 tasks are **render/UI work**: they are verified visually through the preview tooling (the dev server, console-logs, snapshot, screenshot), not unit asserts. Each task's "verify" step is the gate. Use the preview workflow: `preview_start` the dev server, reload, check `preview_console_logs` for errors, then `preview_screenshot` for proof. Scene values (colors, sizes, speeds) are first-pass and tuned iteratively in later steps/Phase 2.

## Task 7: Three.js renderer + render loop

**Files:**
- Modify: `redline3d/index.html`
- Create: `redline3d/src/render/scene.ts`
- Modify: `redline3d/src/main.ts`

- [ ] **Step 1: Replace `index.html` with the canvas + HUD shell**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
    <title>REDLINE 3D</title>
    <style>
      *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
      html,body{margin:0;height:100%;overflow:hidden;background:#05030d}
      body{font-family:ui-rounded,-apple-system,system-ui,sans-serif;color:#eaf0ff;position:fixed;inset:0}
      #gl{position:fixed;inset:0;display:block;width:100%;height:100%;z-index:1}
      #hud{position:fixed;inset:0;z-index:2;pointer-events:none;max-width:460px;margin:0 auto}
      #hud .pe{pointer-events:auto}
    </style>
  </head>
  <body>
    <canvas id="gl"></canvas>
    <div id="hud"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `render/scene.ts`**

```ts
import * as THREE from "three";

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  clock: THREE.Clock;
}

export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#05030d");
  scene.fog = new THREE.Fog("#150a26", 60, 420);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 6, 12);
  camera.lookAt(0, 2, -40);

  scene.add(new THREE.AmbientLight("#8866ff", 0.7));
  const key = new THREE.DirectionalLight("#ff7ad0", 0.8);
  key.position.set(0, 40, -10);
  scene.add(key);

  // sanity object (removed in Task 9)
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(4, 4, 4),
    new THREE.MeshStandardMaterial({ color: "#2ee6a6", emissive: "#0c5", emissiveIntensity: 0.4 })
  );
  cube.position.set(0, 3, -30);
  cube.name = "sanity";
  scene.add(cube);

  addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });

  return { renderer, scene, camera, clock: new THREE.Clock() };
}
```

- [ ] **Step 3: Wire the render loop in `main.ts`**

```ts
import { createScene } from "./render/scene";

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const ctx = createScene(canvas);

function frame() {
  const cube = ctx.scene.getObjectByName("sanity");
  if (cube) cube.rotation.y += 0.02;
  ctx.renderer.render(ctx.scene, ctx.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
console.log("redline3d render up");
```

- [ ] **Step 4: Verify in the preview**

Run: `cd redline3d && npm run dev` (start the dev server via `preview_start`).
Verify with the preview tools:
- `preview_console_logs` → shows "redline3d render up", **no errors/warnings**.
- `preview_screenshot` → a spinning green cube on a near-black background.

Fix any console errors before continuing.

- [ ] **Step 5: Commit**

```bash
git add redline3d/index.html redline3d/src/render/scene.ts redline3d/src/main.ts
git commit -m "feat(render): Three.js renderer + render loop (sanity cube)"
```

---

## Task 8: Wire the price source + a minimal price readout

**Files:**
- Create: `redline3d/src/ui/hud.ts`
- Modify: `redline3d/src/main.ts`

- [ ] **Step 1: Create a minimal HUD with a SOL price readout**

Create `redline3d/src/ui/hud.ts`:

```ts
export interface Hud {
  setPrice(px: number, live: boolean): void;
  root: HTMLElement;
}

export function createHud(parent: HTMLElement): Hud {
  parent.innerHTML = `
    <div class="pe" style="position:absolute;top:max(10px,env(safe-area-inset-top));right:14px;
      background:rgba(8,6,20,.5);border:1px solid rgba(120,140,210,.22);border-radius:10px;
      padding:5px 9px;font-size:10px;font-weight:700;color:#9aa6c8;text-align:right">
      SOL<b id="solpx" style="display:block;color:#eaf0ff;font-size:15px">$—</b>
      <span id="feed" style="color:#ffd166">connecting…</span>
    </div>`;
  const px = parent.querySelector("#solpx") as HTMLElement;
  const feed = parent.querySelector("#feed") as HTMLElement;
  return {
    root: parent,
    setPrice(p, live) {
      px.textContent = "$" + (p ? p.toFixed(2) : "—");
      feed.textContent = live ? "live" : "sim";
      feed.style.color = live ? "#2ee6a6" : "#ffd166";
    },
  };
}
```

- [ ] **Step 2: Wire the real feed into a price source in `main.ts`**

Add to `main.ts` (after `createScene`):

```ts
import { connectFeed } from "./core/feed";
import { createPriceSource } from "./core/price-source";
import { createHud } from "./ui/hud";

const hud = createHud(document.getElementById("hud") as HTMLElement);

const SOL = { key: "SOL", lz: 6, hx: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", expo: -8 };
const priceSource = createPriceSource({
  connect: (onPrice) => {
    const h = connectFeed({ feeds: [SOL], onPrice: (_k, v) => onPrice(v) });
    return () => h.stop();
  },
});
```

In `frame()`, before render:

```ts
hud.setPrice(priceSource.price(), priceSource.live());
```

- [ ] **Step 3: Verify in the preview**

Reload the dev server.
- `preview_console_logs` → no errors.
- `preview_screenshot` → the SOL price chip shows a real dollar value (e.g. `$172.xx`) and "live" (or "sim" if the feed is blocked). Wait ~3s and re-screenshot: the price updates.

- [ ] **Step 4: Commit**

```bash
git add redline3d/src/ui/hud.ts redline3d/src/main.ts
git commit -m "feat: wire Pyth price source into a minimal HUD readout"
```

---

## Task 9: Synthwave world — grid floor, sky, sun

**Files:**
- Create: `redline3d/src/render/world.ts`
- Modify: `redline3d/src/render/scene.ts` (remove sanity cube)
- Modify: `redline3d/src/main.ts`

- [ ] **Step 1: Remove the sanity cube**

In `render/scene.ts`, delete the `cube` block (the `THREE.Mesh` named "sanity" and its `scene.add(cube)`).

- [ ] **Step 2: Create `world.ts` with the grid floor, gradient sky, and sliced sun**

```ts
import * as THREE from "three";

export interface World {
  group: THREE.Group;
  update(dt: number, speed: number): void;
}

function makeSun(): THREE.Group {
  const g = new THREE.Group();
  const colors = ["#ffe24a", "#ffd24a", "#ffb24a", "#ff8a4a", "#ff5a6a", "#ff3a8a", "#d83b6a"];
  for (let i = 0; i < colors.length; i++) {
    const w = 60 - i * 6;
    const bar = new THREE.Mesh(
      new THREE.PlaneGeometry(w, 3.4),
      new THREE.MeshBasicMaterial({ color: colors[i], fog: false })
    );
    bar.position.set(0, 44 - i * 5, -600);
    g.add(bar);
  }
  return g;
}

export function createWorld(): World {
  const group = new THREE.Group();

  // gradient sky dome (vertex-painted)
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(900, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      fog: false,
      uniforms: { top: { value: new THREE.Color("#160a2e") }, bot: { value: new THREE.Color("#7a1d5e") } },
      vertexShader: `varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
      fragmentShader: `varying float h; uniform vec3 top; uniform vec3 bot; void main(){ gl_FragColor = vec4(mix(bot, top, clamp(h*1.4+0.3,0.0,1.0)), 1.0);} `,
    })
  );
  group.add(sky);
  group.add(makeSun());

  // neon grid floor — a large plane with a scrolling grid shader
  const gridMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uOffset: { value: 0 }, uColor: { value: new THREE.Color("#ff39c0") }, uColor2: { value: new THREE.Color("#27e7ff") } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `
      varying vec2 vUv; uniform float uOffset; uniform vec3 uColor; uniform vec3 uColor2;
      float line(float x){ float g = abs(fract(x)-0.5); return smoothstep(0.48,0.5,1.0-g*2.0); }
      void main(){
        float gx = line(vUv.x*40.0);
        float gz = line(vUv.y*120.0 + uOffset);
        float g = max(gx, gz);
        vec3 c = mix(uColor2, uColor, vUv.x);
        float fade = smoothstep(0.0, 0.35, vUv.y);
        gl_FragColor = vec4(c, g * fade * 0.9);
      }`,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(800, 2000, 1, 1), gridMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -900);
  group.add(floor);

  return {
    group,
    update(dt, speed) {
      gridMat.uniforms.uOffset.value += dt * speed * 0.02;
    },
  };
}
```

- [ ] **Step 3: Add the world to the scene in `main.ts`**

```ts
import { createWorld } from "./render/world";
const world = createWorld();
ctx.scene.add(world.group);
```

In `frame()`, delete the two sanity-cube lines (`const cube = ...` and `if (cube) ...`) and instead compute `dt` once and update the world:

```ts
const dt = ctx.clock.getDelta();
world.update(dt, 30);
```

- [ ] **Step 4: Verify in the preview**

Reload.
- `preview_console_logs` → no shader-compile errors.
- `preview_screenshot` → a neon grid floor receding to a horizon, a gradient purple→magenta sky, and the sliced retro sun. The grid lines scroll toward the camera over time (re-screenshot to confirm motion).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/render/world.ts redline3d/src/render/scene.ts redline3d/src/main.ts
git commit -m "feat(render): synthwave world — grid floor, sky dome, sliced sun"
```

---

## Task 10: The road

**Files:**
- Modify: `redline3d/src/render/world.ts`
- Modify: `redline3d/src/main.ts`

- [ ] **Step 1: Add a scrolling road strip to `world.ts`**

Add inside `createWorld()` before the `return`, and extend `update`:

```ts
  // road: a dark reflective strip down the middle with emissive neon edges
  const roadMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uOffset: { value: 0 }, uEdge: { value: new THREE.Color("#ff39c0") } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `
      varying vec2 vUv; uniform float uOffset; uniform vec3 uEdge;
      void main(){
        float edge = smoothstep(0.0,0.06,vUv.x) * smoothstep(1.0,0.94,vUv.x);
        float edges = 1.0 - edge;
        float dash = step(0.5, fract(vUv.y*60.0 + uOffset)) * step(0.46,vUv.x)*step(vUv.x,0.54);
        vec3 road = vec3(0.06,0.07,0.12);
        vec3 col = mix(road, uEdge, edges*0.9) + dash*vec3(0.9);
        float fade = smoothstep(0.0,0.3,vUv.y);
        gl_FragColor = vec4(col, fade);
      }`,
  });
  const road = new THREE.Mesh(new THREE.PlaneGeometry(26, 2000, 1, 1), roadMat);
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.02, -900);
  group.add(road);
```

Change the returned `update` to also scroll the road:

```ts
    update(dt, speed) {
      gridMat.uniforms.uOffset.value += dt * speed * 0.02;
      roadMat.uniforms.uOffset.value += dt * speed * 0.02;
    },
```

- [ ] **Step 2: Verify in the preview**

Reload.
- `preview_console_logs` → no errors.
- `preview_screenshot` → a dark road strip with glowing neon edges and a dashed centre line running down the middle of the grid toward the horizon; dashes scroll over time.

- [ ] **Step 3: Commit**

```bash
git add redline3d/src/render/world.ts
git commit -m "feat(render): neon road strip with scrolling centre dashes"
```

---

## Task 11: The car

**Files:**
- Create: `redline3d/src/render/car.ts`
- Modify: `redline3d/src/main.ts`

- [ ] **Step 1: Create `car.ts` — a procedural low-poly car with equity color**

```ts
import * as THREE from "three";

export interface Car {
  group: THREE.Group;
  /** color by equity state: idle blue, winning green, losing red */
  setEquity(phase: "idle" | "live", equity: number): void;
  update(dt: number): void;
}

export function createCar(): Car {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: "#11131f", emissive: "#4da6ff", emissiveIntensity: 0.5, metalness: 0.4, roughness: 0.4 });
  const glowMat = new THREE.MeshStandardMaterial({ color: "#ff2d55", emissive: "#ff2d55", emissiveIntensity: 1.2 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.0, 7.2), bodyMat);
  body.position.y = 0.9;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.0, 1.0, 3.0), bodyMat);
  cabin.position.set(0, 1.7, 0.3);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.4, 0.5), glowMat); // rear light bar
  tail.position.set(0, 1.0, 3.7);
  group.add(body, cabin, tail);

  // underglow
  const glow = new THREE.PointLight("#4da6ff", 8, 18, 2);
  glow.position.set(0, 0.4, 0);
  group.add(glow);

  let t = 0;
  return {
    group,
    setEquity(phase, equity) {
      const col = phase === "idle" ? "#4da6ff" : equity >= 1 ? "#2ee6a6" : "#ff5067";
      bodyMat.emissive.set(col);
      glow.color.set(col);
    },
    update(dt) {
      t += dt;
      group.position.y = Math.sin(t * 2.2) * 0.05; // idle hover wobble
    },
  };
}
```

- [ ] **Step 2: Add the car in `main.ts`**

```ts
import { createCar } from "./render/car";
const car = createCar();
car.group.position.set(0, 0, 0);
ctx.scene.add(car.group);
```

In `frame()`:

```ts
car.update(dt);
```

- [ ] **Step 3: Verify in the preview**

Reload.
- `preview_console_logs` → no errors.
- `preview_screenshot` → a low-poly car sits on the road in the foreground (rear-3/4 view from the chase camera), glowing blue with a red rear light bar; it hovers gently.

- [ ] **Step 4: Commit**

```bash
git add redline3d/src/render/car.ts redline3d/src/main.ts
git commit -m "feat(render): procedural low-poly car with equity color + underglow"
```

---

## Task 12: Chase camera with risk-driven speed/FOV

**Files:**
- Create: `redline3d/src/render/camera.ts`
- Modify: `redline3d/src/main.ts`

- [ ] **Step 1: Create `camera.ts`**

`speedFor`/`fovFor` map leverage and equity to road speed and FOV — this is the "risk made physical" lever. `levFrac` comes from the core.

```ts
import * as THREE from "three";
import { levFrac } from "../core/leverage";

export interface ChaseCam {
  /** call each frame with current leverage + equity; returns the road speed to scroll */
  update(camera: THREE.PerspectiveCamera, dt: number, lev: number, equity: number, live: boolean): number;
}

export function createChaseCam(): ChaseCam {
  let fov = 70;
  return {
    update(camera, _dt, lev, equity, live) {
      // road speed: slow at min lev, fast (not warp) near redline; winning revs faster
      const base = 24 + Math.pow(levFrac(lev), 1.5) * 600;
      const boost = live ? Math.max(0.9, Math.min(1.4, 0.9 + Math.max(0, equity) * 0.06)) : 1;
      const speed = base * boost;
      // FOV widens with speed for a visceral rush
      const targetFov = 66 + Math.min(26, (speed / 640) * 26);
      fov += (targetFov - fov) * 0.08;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      return speed * 0.05; // scale into world units/sec for world.update
    },
  };
}
```

- [ ] **Step 2: Wire it in `main.ts`**

Replace the hardcoded `world.update(dt, 30)` with camera-driven speed. Add a module-level game state object you will expand in Task 13:

```ts
import { createChaseCam } from "./render/camera";
const chase = createChaseCam();
const game = { lev: 50, equity: 1, phase: "idle" as "idle" | "live", live: false };
```

In `frame()`:

```ts
const speed = chase.update(ctx.camera, dt, game.lev, game.equity, game.phase === "live");
world.update(dt, speed);
```

- [ ] **Step 3: Verify in the preview**

Reload.
- `preview_console_logs` → no errors.
- `preview_screenshot` → scene renders as before; the grid/road scroll at the base speed. (Speed/FOV changes become visible once leverage is interactive in Task 13.)

- [ ] **Step 4: Commit**

```bash
git add redline3d/src/render/camera.ts redline3d/src/main.ts
git commit -m "feat(render): chase camera with leverage/equity-driven speed + FOV"
```

---

## Task 13: HUD, tach, controls — wire to the core (playable!)

This is the milestone task: launch a round, watch the multiplier climb on the live SOL price, cash out or get liquidated.

**Files:**
- Modify: `redline3d/src/ui/hud.ts`
- Create: `redline3d/src/ui/tach.ts`
- Create: `redline3d/src/ui/controls.ts`
- Modify: `redline3d/src/main.ts`

- [ ] **Step 1: Expand the HUD with balance, multiplier, status, and liq buffer**

Replace `ui/hud.ts` with:

```ts
export interface Hud {
  root: HTMLElement;
  setPrice(px: number, live: boolean): void;
  setBalance(b: number): void;
  setMultiplier(equity: number, phase: "idle" | "live" | "settled" | "liquidated"): void;
  setBuffer(buf: number, visible: boolean): void;
  setStatus(text: string): void;
}

export function createHud(parent: HTMLElement): Hud {
  parent.innerHTML = `
    <div class="pe" style="position:absolute;top:max(10px,env(safe-area-inset-top));left:14px;
      background:rgba(8,6,20,.5);border:1px solid rgba(120,140,210,.22);border-radius:10px;padding:5px 9px;font-size:10px;font-weight:700;color:#9aa6c8">
      balance<b id="bal" style="display:block;color:#eaf0ff;font-size:15px">$100.00</b></div>
    <div class="pe" style="position:absolute;top:max(10px,env(safe-area-inset-top));right:14px;text-align:right;
      background:rgba(8,6,20,.5);border:1px solid rgba(120,140,210,.22);border-radius:10px;padding:5px 9px;font-size:10px;font-weight:700;color:#9aa6c8">
      SOL<b id="solpx" style="display:block;color:#eaf0ff;font-size:15px">$—</b><span id="feed" style="color:#ffd166">connecting…</span></div>
    <div style="position:absolute;left:0;right:0;top:34%;text-align:center">
      <div id="multi" style="font-family:ui-monospace,monospace;font-weight:800;font-size:58px;color:#2ee6a6">×1.00</div>
      <div id="buf" style="width:188px;max-width:62vw;height:8px;margin:11px auto 0;border-radius:6px;background:rgba(8,6,20,.62);border:1px solid rgba(120,140,210,.28);overflow:hidden;opacity:0">
        <div id="buffill" style="height:100%;width:100%;background:#2ee6a6"></div></div>
    </div>
    <div id="status" style="position:absolute;left:0;right:0;bottom:128px;text-align:center;font-size:11px;color:#cdd6f5;padding:0 14px"></div>`;
  const q = (s: string) => parent.querySelector(s) as HTMLElement;
  const bal = q("#bal"), px = q("#solpx"), feed = q("#feed"), multi = q("#multi"),
    buf = q("#buf"), buffill = q("#buffill"), status = q("#status");
  return {
    root: parent,
    setPrice(p, live) { px.textContent = "$" + (p ? p.toFixed(2) : "—"); feed.textContent = live ? "live" : "sim"; feed.style.color = live ? "#2ee6a6" : "#ffd166"; },
    setBalance(b) { bal.textContent = "$" + b.toFixed(2); },
    setMultiplier(equity, phase) {
      multi.textContent = "×" + equity.toFixed(2);
      multi.style.color = phase === "liquidated" ? "#ff4d6d" : equity >= 1 ? "#2ee6a6" : "#ff5067";
    },
    setBuffer(b, visible) {
      buf.style.opacity = visible ? "1" : "0";
      buffill.style.width = (b * 100).toFixed(1) + "%";
      buffill.style.background = b > 0.5 ? "#2ee6a6" : b > 0.25 ? "#ffd166" : "#ff4d6d";
    },
    setStatus(t) { status.textContent = t; },
  };
}
```

- [ ] **Step 2: Create the tach control `ui/tach.ts`**

A simplified leverage dial: a horizontal range that maps to throttle 0–100 → leverage via the core. (The full curved SVG tach is a Phase 2 polish item; this is functional.)

```ts
import { tToLev, niceLev } from "../core/leverage";

export interface Tach {
  el: HTMLElement;
  lev(): number;
  onChange(cb: (lev: number) => void): void;
}

export function createTach(parent: HTMLElement): Tach {
  const wrap = document.createElement("div");
  wrap.className = "pe";
  wrap.style.cssText = "position:absolute;left:14px;right:14px;bottom:74px;text-align:center";
  wrap.innerHTML = `
    <div id="levval" style="font-family:ui-monospace,monospace;font-weight:900;font-size:22px;color:#2ee6a6">50×</div>
    <input id="thr" type="range" min="0" max="100" value="34" style="width:100%" />
    <div style="font-size:9px;letter-spacing:.12em;color:#6a76a0;font-weight:800">LEVERAGE</div>`;
  parent.appendChild(wrap);
  const thr = wrap.querySelector("#thr") as HTMLInputElement;
  const val = wrap.querySelector("#levval") as HTMLElement;
  let lev = niceLev(tToLev(+thr.value));
  let cb: (lev: number) => void = () => {};
  const recompute = () => {
    lev = niceLev(tToLev(+thr.value));
    val.textContent = lev + "×";
    val.style.color = lev >= 400 ? "#ff4d6d" : lev >= 170 ? "#ffd166" : "#2ee6a6";
    cb(lev);
  };
  thr.addEventListener("input", recompute);
  recompute();
  return { el: wrap, lev: () => lev, onChange: (fn) => (cb = fn) };
}
```

- [ ] **Step 3: Create `ui/controls.ts` — long/short toggle, stake, LAUNCH/CASH-OUT**

```ts
export interface Controls {
  dir(): 1 | -1;
  stake(): number;
  setLive(live: boolean, label: string): void;
  onLaunch(cb: () => void): void;
  onCashout(cb: () => void): void;
}

export function createControls(parent: HTMLElement): Controls {
  const wrap = document.createElement("div");
  wrap.className = "pe";
  wrap.style.cssText = "position:absolute;left:14px;right:14px;bottom:14px;display:flex;flex-direction:column;gap:8px";
  wrap.innerHTML = `
    <div style="display:flex;gap:8px">
      <div id="long" style="flex:1;text-align:center;padding:8px;border:1px solid #2ee6a6;border-radius:10px;color:#2ee6a6;font-weight:800;background:rgba(46,230,166,.18)">▲ LONG</div>
      <div id="short" style="flex:1;text-align:center;padding:8px;border:1px solid rgba(120,140,210,.3);border-radius:10px;color:#9aa6c8;font-weight:800">▼ SHORT</div>
      <div style="display:flex;align-items:center;gap:6px">
        <div id="sdn" style="width:30px;height:30px;border:1px solid rgba(120,140,210,.3);border-radius:9px;text-align:center;line-height:30px;font-weight:800">−</div>
        <div id="sval" style="min-width:48px;text-align:center;font-weight:900">$1</div>
        <div id="sup" style="width:30px;height:30px;border:1px solid rgba(120,140,210,.3);border-radius:9px;text-align:center;line-height:30px;font-weight:800">+</div>
      </div>
    </div>
    <button id="go" style="width:100%;border:none;border-radius:14px;padding:15px;font-size:17px;font-weight:900;text-transform:uppercase;color:#06121a;background:linear-gradient(180deg,#43f0b0,#13c98a)">🚀 LAUNCH</button>`;
  parent.appendChild(wrap);
  const q = (s: string) => wrap.querySelector(s) as HTMLElement;
  let d: 1 | -1 = 1, stake = 1, live = false;
  let launchCb = () => {}, cashCb = () => {};
  const long = q("#long"), short = q("#short"), sval = q("#sval"), go = q("#go");
  const setDir = (nd: 1 | -1) => {
    if (live) return;
    d = nd;
    long.style.cssText = long.style.cssText.replace(/border-color:[^;]*;?/, "");
    long.style.borderColor = nd === 1 ? "#2ee6a6" : "rgba(120,140,210,.3)";
    long.style.color = nd === 1 ? "#2ee6a6" : "#9aa6c8";
    long.style.background = nd === 1 ? "rgba(46,230,166,.18)" : "transparent";
    short.style.borderColor = nd === -1 ? "#ff4d6d" : "rgba(120,140,210,.3)";
    short.style.color = nd === -1 ? "#ff4d6d" : "#9aa6c8";
    short.style.background = nd === -1 ? "rgba(255,77,109,.18)" : "transparent";
  };
  long.onclick = () => setDir(1);
  short.onclick = () => setDir(-1);
  q("#sup").onclick = () => { if (!live) { stake = Math.min(50, stake + 1); sval.textContent = "$" + stake; } };
  q("#sdn").onclick = () => { if (!live) { stake = Math.max(1, stake - 1); sval.textContent = "$" + stake; } };
  go.onclick = () => (live ? cashCb() : launchCb());
  return {
    dir: () => d,
    stake: () => stake,
    setLive(l, label) {
      live = l;
      go.textContent = label;
      go.style.background = l ? "linear-gradient(180deg,#ffe08a,#ffc23d)" : "linear-gradient(180deg,#43f0b0,#13c98a)";
    },
    onLaunch: (cb) => (launchCb = cb),
    onCashout: (cb) => (cashCb = cb),
  };
}
```

- [ ] **Step 4: Wire it all together in `main.ts`**

Add the round engine + settlement and connect the UI. Full wiring block (place after the `game`, `hud`, `priceSource`, `world`, `car`, `chase` are created):

```ts
import { RoundEngine } from "./core/round";
import { SimSettlement } from "./core/settlement";
import { createTach } from "./ui/tach";
import { createControls } from "./ui/controls";

const engine = new RoundEngine();
const wallet = new SimSettlement();
const hudRoot = document.getElementById("hud") as HTMLElement;
const tach = createTach(hudRoot);
const controls = createControls(hudRoot);

hud.setBalance(wallet.balance());
tach.onChange((lev) => {
  game.lev = lev;
  if (engine.getPhase() === "live") engine.setLeverage(lev, priceSource.price());
});

controls.onLaunch(() => {
  const stake = controls.stake();
  if (!wallet.canAfford(stake)) { hud.setStatus("Not enough balance — lower your stake."); return; }
  const entry = priceSource.price();
  if (!entry) { hud.setStatus("Waiting for the SOL feed…"); return; }
  wallet.debit(stake);
  hud.setBalance(wallet.balance());
  engine.launch({ dir: controls.dir(), lev: tach.lev(), stake, entryRaw: entry, startMs: Date.now() });
  game.phase = "live";
  controls.setLive(true, "CASH OUT");
  hud.setStatus(`Riding ${controls.dir() > 0 ? "LONG" : "SHORT"} SOL at ${tach.lev()}× from $${entry.toFixed(2)}.`);
});

function endRound(snap: import("./core/types").Snapshot) {
  wallet.credit(snap.payout);
  hud.setBalance(wallet.balance());
  game.phase = "idle";
  controls.setLive(false, "🚀 LAUNCH");
  hud.setBuffer(0, false);
  if (snap.phase === "liquidated") hud.setStatus(`💥 Liquidated at ${snap.lev}×. Lost your stake.`);
  else hud.setStatus(`Settled at ×${snap.equity.toFixed(2)} — banked $${snap.payout.toFixed(2)} (${snap.reason}).`);
}

controls.onCashout(() => {
  if (engine.getPhase() !== "live") return;
  endRound(engine.cashout(priceSource.price(), Date.now()));
});
```

In `frame()`, replace the price/multiplier section with the live round update:

```ts
const price = priceSource.price();
hud.setPrice(price, priceSource.live());
if (engine.getPhase() === "live") {
  const snap = engine.tick(price, Date.now());
  game.equity = snap.equity;
  hud.setMultiplier(snap.equity, snap.phase);
  hud.setBuffer(snap.buffer, true);
  car.setEquity("live", snap.equity);
  if (snap.phase !== "live") endRound(snap);
  else controls.setLive(true, `CASH OUT $${snap.payout.toFixed(2)}`);
} else {
  car.setEquity("idle", 1);
}
```

- [ ] **Step 5: Verify the full play loop in the preview**

Reload. Then drive the game with the preview tools:
- `preview_screenshot` → HUD shows balance $100, a SOL price, the ×1.00 multiplier, the leverage tach, LONG/SHORT, stake, and LAUNCH.
- `preview_click` the `#go` button (LAUNCH). `preview_screenshot` → button now reads "CASH OUT $…", the liq buffer bar is visible, the multiplier moves off ×1.00 as the real SOL price ticks (re-screenshot after ~2s to see it change).
- `preview_click` `#go` again (CASH OUT). `preview_screenshot` → balance updates by the payout, status shows the settle message, button returns to LAUNCH.
- `preview_console_logs` → no errors throughout.

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/ui/hud.ts redline3d/src/ui/tach.ts redline3d/src/ui/controls.ts redline3d/src/main.ts
git commit -m "feat(ui): HUD + tach + controls wired to RoundEngine — playable 3D Redline"
```

---

## Task 14: Bloom post-processing (perf-gated)

**Files:**
- Create: `redline3d/src/platform/perf.ts`
- Create: `redline3d/src/render/post.ts`
- Modify: `redline3d/src/main.ts`

- [ ] **Step 1: Create `platform/perf.ts` — device tier + quality flags**

```ts
export interface Quality {
  tier: "low" | "high";
  bloom: boolean;
  pixelRatioCap: number;
}

export function detectQuality(): Quality {
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const low = mem <= 3 || cores <= 4;
  return { tier: low ? "low" : "high", bloom: !low, pixelRatioCap: low ? 1.5 : 2 };
}
```

- [ ] **Step 2: Create `render/post.ts` — bloom composer**

```ts
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export interface Post {
  render(): void;
  setSize(w: number, h: number): void;
}

export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Post {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.9, 0.6, 0.85);
  composer.addPass(bloom);
  return {
    render: () => composer.render(),
    setSize: (w, h) => composer.setSize(w, h),
  };
}
```

- [ ] **Step 3: Use it in `main.ts` (gated by quality)**

```ts
import { detectQuality } from "./platform/perf";
import { createPost } from "./render/post";

const quality = detectQuality();
ctx.renderer.setPixelRatio(Math.min(quality.pixelRatioCap, window.devicePixelRatio || 1));
const post = quality.bloom ? createPost(ctx.renderer, ctx.scene, ctx.camera) : null;
addEventListener("resize", () => post?.setSize(window.innerWidth, window.innerHeight));
```

Replace the `ctx.renderer.render(...)` call in `frame()` with:

```ts
if (post) post.render();
else ctx.renderer.render(ctx.scene, ctx.camera);
```

- [ ] **Step 4: Verify in the preview**

Reload.
- `preview_console_logs` → no errors (verify the `three/examples/jsm` imports resolve under Vite).
- `preview_screenshot` → the neon grid, road edges, sun, and car glow now **bloom** — brighter, with soft light bleed. The scene reads markedly more "neon."

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/platform/perf.ts redline3d/src/render/post.ts redline3d/src/main.ts
git commit -m "feat(render): perf-gated UnrealBloom post-processing"
```

---

## Task 15: Production build + Phase-1 acceptance

**Files:** none (verification + tag)

- [ ] **Step 1: Type-check and production build**

Run: `cd redline3d && npm run build`
Expected: `tsc --noEmit` passes (no type errors) and Vite produces `dist/` with no errors.

- [ ] **Step 2: Verify the production build runs**

Run: `cd redline3d && npm run preview` (serve `dist/` via the preview tooling).
- `preview_console_logs` → no errors.
- `preview_screenshot` → the full playable scene renders from the built bundle.

- [ ] **Step 3: Full acceptance pass against the spec's Phase 1 definition**

Confirm each, using the preview tools, and note results:
- [ ] Loads to a synthwave 3D scene (grid, sky, sun, road, car) with bloom.
- [ ] SOL price is live (or sim) in the HUD and updates.
- [ ] LAUNCH debits the stake; multiplier tracks the real price via the core; liq buffer shows.
- [ ] CASH OUT credits payout; balance changes correctly.
- [ ] A liquidation path works (launch at high leverage against the position and watch it wreck) — verify the multiplier hits ×0.00 / liquidated status.
- [ ] No console errors across a full launch→settle cycle.

- [ ] **Step 4: Run the full test suite once more**

Run: `cd redline3d && npm run test`
Expected: PASS — all Phase 0 core suites still green.

- [ ] **Step 5: Commit a checkpoint**

```bash
git commit --allow-empty -m "chore: Phase 1 acceptance — playable 3D Redline on the tested core"
```

---

## Notes for the next plans (out of scope here)

- **Phase 2 (feel):** 3D fly-off + explosion cinematics (port `explode`/`jet`/`burst` semantics to 3D debris/particles), WebAudio engine drone + cues, haptics via `platform/haptics.ts`, camera shake near the redline, the full curved SVG tach, milestone pops, minimap price chart, `prefers-reduced-motion`.
- **Phase 3 (Seeker packaging):** Capacitor `android/`, PWA manifest + offline shell, portrait lock, `platform/wallet.ts` MWA stub, status-bar/splash, dApp-Store-clean build.
- **Money track (separate gated spec):** `VaultSettlement`, server-authoritative settlement + resolver, vault, FlashTrade hedging, compliance, legal read.
