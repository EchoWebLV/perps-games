# Highway Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third game mode — a free-drive divided oval highway where direction (LONG/SHORT) is picked at GO and locked, and speed drives a 10×–100× leverage gear ladder — plus Phase-2 ghost cars via a tiny WebSocket presence relay. On-chain program untouched.

**Architecture:** Pure-core modules (`track.ts` stadium geometry, `highway-gears.ts` ladder) feed a new `mode === "highway"` branch in `main.ts` that reuses the lobby's free-drive physics (`freedrive.step`), the lobby chase cam, and the existing on-chain round machinery (`game-session.open/noteLeverage/close`, lever-sync, crank). A new `render/oval.ts` builds the static track world the same way `render/lobby.ts` builds the lot. Phase 2 adds `server/presence.mjs` (ws fan-out) + `redline3d/src/net/presence.ts` (throttle/interpolate) feeding `oval.setRemoteCars`.

**Tech Stack:** TypeScript, Three.js, Vite, vitest, `ws` (server), existing Anchor/MagicBlock client (unchanged).

**Spec:** `docs/superpowers/specs/2026-07-02-highway-mode-design.md`

**Working branch:** `onchain-er-rebuild` (all prior on-chain work lives here, unpushed). All paths below are relative to the repo root `/Users/yordanlasonov/Documents/GitHub/perps-games`.

**Conventions that matter here:**
- redline3d tests: `cd redline3d && npm test` (vitest). Compile gate: `cd redline3d && npm run build` (runs `tsc --noEmit` first).
- Pure core modules have NO `three`/DOM imports (see `src/core/freedrive.ts`).
- Renderer modules (`render/lobby.ts`) have no unit tests — verified by compile + browser. Follow that precedent for `render/oval.ts`.
- `controls.dir()` already locks while live (`setDir` refuses when `live` — `src/ui/controls.ts:65`), so "direction locked for the round" needs no new code.
- `RoundEngine.setLeverage` and `leverSync` both no-op on unchanged values, so calling them every frame is safe (the race branch already does — `src/main.ts:609`).
- Player-facing copy must never say "session"/"delegate" (see memory rule); reuse existing status strings.

---

## Phase 1 — Solo highway

### Task 0: Baseline

**Files:** none (verification only)

- [ ] **Step 0.1: Confirm the suite is green before touching anything**

Run: `cd redline3d && npm test`
Expected: all existing tests pass. If anything fails, STOP and report — do not start on a red baseline.

---

### Task 1: `track.ts` — stadium oval geometry (pure, TDD)

The analytic centerline: two straights (length `STRAIGHT`) along the Z axis at `x = ±R`, joined by two semicircular arcs (radius `R`). Arc-length parameter `s ∈ [0, LEN)`, `s = 0` at world `(R, STRAIGHT/2)` heading north (−Z, heading 0). Heading convention matches `freedrive.ts`: heading 0 faces −Z, forward = `(sin h, −cos h)`. The right-hand normal of travel is `(cos h, sin h)`; **lateral offset > 0 = right of increasing-s travel = the OUTER side**. LONG traffic drives increasing-s in the outer carriageway; SHORT drives decreasing-s in the inner one (each keeps its own right-hand side, like a real highway). The raised median is a hard barrier: `contain` clamps `|lateral|` into `[MEDIAN_HALF + WALL_PAD, EDGE − WALL_PAD]` preserving side, so you physically cannot cross to oncoming.

**Files:**
- Create: `redline3d/src/core/track.ts`
- Create: `redline3d/src/core/track.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `redline3d/src/core/track.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TRACK, LEN, sample, progress, contain, spawnPose, HW_BOUNDS } from "./track";

const { R, STRAIGHT, MEDIAN_HALF, EDGE } = TRACK;

describe("track sample()", () => {
  it("starts on the east straight heading north (heading 0)", () => {
    const c = sample(0);
    expect(c.x).toBeCloseTo(R);
    expect(c.z).toBeCloseTo(STRAIGHT / 2);
    expect(c.heading).toBeCloseTo(0);
  });

  it("reaches the west straight heading south (heading π) after straight+arc", () => {
    const c = sample(STRAIGHT + Math.PI * R);
    expect(c.x).toBeCloseTo(-R);
    expect(c.z).toBeCloseTo(-STRAIGHT / 2);
    expect(Math.abs(c.heading)).toBeCloseTo(Math.PI);
  });

  it("is at the top of the north arc, heading west, at straight + quarter arc", () => {
    const c = sample(STRAIGHT + (Math.PI / 2) * R);
    expect(c.x).toBeCloseTo(0);
    expect(c.z).toBeCloseTo(-STRAIGHT / 2 - R);
    expect(c.heading).toBeCloseTo(-Math.PI / 2); // forward = (-1, 0) = west
  });

  it("wraps: sample(LEN) equals sample(0)", () => {
    const a = sample(0), b = sample(LEN);
    expect(b.x).toBeCloseTo(a.x);
    expect(b.z).toBeCloseTo(a.z);
  });
});

describe("track progress()", () => {
  it("projects a point right of the east straight to positive (outer) lateral", () => {
    const p = progress(R + 5, 40);
    expect(p.lateralOffset).toBeCloseTo(5);
    expect(p.s).toBeCloseTo(STRAIGHT / 2 - 40);
    expect(p.tangentHeading).toBeCloseTo(0);
  });

  it("projects a point outside the west straight to positive lateral too (outward = +)", () => {
    const p = progress(-R - 5, 0);
    expect(p.lateralOffset).toBeCloseTo(5);
    expect(p.tangentHeading).toBeCloseTo(Math.PI);
  });

  it("projects an inner-carriageway point to negative lateral", () => {
    expect(progress(R - 5, 40).lateralOffset).toBeCloseTo(-5);
  });

  it("projects arc points radially (lateral = distance from arc center − R)", () => {
    // north arc: center (0, −STRAIGHT/2); a point straight up from the center at radius R+3
    const p = progress(0, -STRAIGHT / 2 - (R + 3));
    expect(p.lateralOffset).toBeCloseTo(3);
    expect(p.s).toBeCloseTo(STRAIGHT + (Math.PI / 2) * R);
  });

  it("round-trips sample(): progress(sample(s)) recovers s with ~0 lateral", () => {
    for (const s of [10, STRAIGHT / 2, STRAIGHT + 20, STRAIGHT + Math.PI * R + 50, LEN - 5]) {
      const c = sample(s);
      const p = progress(c.x, c.z);
      expect(p.lateralOffset).toBeCloseTo(0, 5);
      expect(p.s).toBeCloseTo(s, 3);
    }
  });
});

describe("track contain()", () => {
  it("leaves a mid-carriageway point alone", () => {
    const c = contain(R + MEDIAN_HALF + 5, 40);
    expect(c.hitWall).toBe(false);
    expect(c.x).toBeCloseTo(R + MEDIAN_HALF + 5);
    expect(c.z).toBeCloseTo(40);
  });

  it("clamps a point past the outer barrier back in and reports the hit", () => {
    const c = contain(R + EDGE + 4, 40);
    expect(c.hitWall).toBe(true);
    expect(c.x).toBeLessThan(R + EDGE);
  });

  it("blocks the median: a point on the centerline is pushed back to its own side", () => {
    const c = contain(R + 0.2, 40); // barely on the outer side of the centerline
    expect(c.hitWall).toBe(true);
    expect(c.x).toBeGreaterThan(R + MEDIAN_HALF); // pushed out of the median, same side
  });

  it("contains on the arcs too (radial clamp)", () => {
    const c = contain(0, -STRAIGHT / 2 - (R + EDGE + 6));
    expect(c.hitWall).toBe(true);
    const d = Math.hypot(c.x - 0, c.z + STRAIGHT / 2);
    expect(d).toBeLessThan(R + EDGE);
  });
});

describe("track spawnPose()", () => {
  it("LONG spawns in the outer carriageway on the east straight, heading north", () => {
    const p = spawnPose(1);
    expect(p.x).toBeGreaterThan(R + MEDIAN_HALF);
    expect(p.x).toBeLessThan(R + EDGE);
    expect(p.heading).toBeCloseTo(0);
    expect(p.speed).toBe(0);
  });

  it("SHORT spawns in the inner carriageway heading the other way", () => {
    const p = spawnPose(-1);
    expect(p.x).toBeGreaterThan(R - EDGE);
    expect(p.x).toBeLessThan(R - MEDIAN_HALF);
    expect(Math.abs(p.heading)).toBeCloseTo(Math.PI);
  });

  it("both spawn poses survive contain() untouched", () => {
    for (const d of [1, -1] as const) {
      const p = spawnPose(d);
      expect(contain(p.x, p.z).hitWall).toBe(false);
    }
  });
});

describe("HW_BOUNDS", () => {
  it("is generous enough that freedrive's rectangular clamp never fires on the track", () => {
    expect(HW_BOUNDS.x).toBeGreaterThan(R + EDGE + 20);
    expect(HW_BOUNDS.z).toBeGreaterThan(STRAIGHT / 2 + R + EDGE + 20);
  });
});
```

- [ ] **Step 1.2: Run the tests to verify they fail**

Run: `cd redline3d && npx vitest run src/core/track.test.ts`
Expected: FAIL — `Cannot find module './track'` (or equivalent).

- [ ] **Step 1.3: Implement `track.ts`**

Create `redline3d/src/core/track.ts`:

```ts
import type { DriveState } from "./freedrive";

/** Stadium oval: two straights along Z at x=±R joined by semicircular arcs.
 *  All units are world units (the lobby lot is 240×240 for scale). */
export const TRACK = {
  R: 60,           // centerline arc radius
  STRAIGHT: 200,   // straight length
  MEDIAN_HALF: 2,  // half-width of the raised median (a hard barrier — no crossing)
  LANE_W: 6,       // one lane; a carriageway is two lanes
  EDGE: 14,        // median centerline → outer barrier (MEDIAN_HALF + 2 lanes)
  WALL_PAD: 0.8,   // car half-width buffer against median/barrier
};

/** total centerline length */
export const LEN = 2 * TRACK.STRAIGHT + 2 * Math.PI * TRACK.R;

/** generous rectangular bounds handed to freedrive.step — contain() is the real wall */
export const HW_BOUNDS = { x: 400, z: 400 };

export interface TrackPoint { x: number; z: number; heading: number }
export interface TrackProgress { s: number; lateralOffset: number; tangentHeading: number }

const { R, STRAIGHT, MEDIAN_HALF, EDGE, WALL_PAD, LANE_W } = TRACK;
const HALF = STRAIGHT / 2;

/** centerline point + forward tangent heading at arc length s (wraps). Heading 0 faces −Z. */
export function sample(s: number): TrackPoint {
  let t = s % LEN;
  if (t < 0) t += LEN;
  if (t < STRAIGHT) {
    // east straight, north-bound: (R, HALF) → (R, −HALF)
    return { x: R, z: HALF - t, heading: 0 };
  }
  t -= STRAIGHT;
  if (t < Math.PI * R) {
    // north arc, center (0, −HALF): θ 0→π sweeps east → west over the top
    const th = t / R;
    return { x: R * Math.cos(th), z: -HALF - R * Math.sin(th), heading: -th };
  }
  t -= Math.PI * R;
  if (t < STRAIGHT) {
    // west straight, south-bound: (−R, −HALF) → (−R, HALF)
    return { x: -R, z: -HALF + t, heading: Math.PI };
  }
  t -= STRAIGHT;
  // south arc, center (0, HALF): θ 0→π sweeps west → east under the bottom
  const th = t / R;
  return { x: -R * Math.cos(th), z: HALF + R * Math.sin(th), heading: Math.PI - th };
}

/** project a world point onto the centerline. lateralOffset > 0 = right of
 *  increasing-s travel = the OUTER side of the loop. */
export function progress(x: number, z: number): TrackProgress {
  if (z < -HALF) {
    // north arc: radial projection around (0, −HALF)
    const dx = x, dz = z + HALF;
    const th = Math.atan2(-dz, dx); // pos = (r cosθ, −r sinθ) rel. center, θ ∈ [0, π]
    const r = Math.hypot(dx, dz);
    return { s: STRAIGHT + th * R, lateralOffset: r - R, tangentHeading: -th };
  }
  if (z > HALF) {
    // south arc: radial projection around (0, HALF)
    const dx = x, dz = z - HALF;
    const th = Math.atan2(dz, -dx); // pos = (−r cosθ, r sinθ) rel. center, θ ∈ [0, π]
    const r = Math.hypot(dx, dz);
    return { s: 2 * STRAIGHT + Math.PI * R + th * R, lateralOffset: r - R, tangentHeading: Math.PI - th };
  }
  if (x >= 0) {
    // east straight (north-bound): right of travel = +x (outward)
    return { s: HALF - z, lateralOffset: x - R, tangentHeading: 0 };
  }
  // west straight (south-bound): right of travel = −x (outward)
  return { s: STRAIGHT + Math.PI * R + (z + HALF), lateralOffset: -(x + R), tangentHeading: Math.PI };
}

/** clamp a point onto the drivable ribbon of ITS OWN side of the median.
 *  The median (|lat| < MEDIAN_HALF) and the outer barrier (|lat| > EDGE) are walls. */
export function contain(x: number, z: number): { x: number; z: number; hitWall: boolean } {
  const p = progress(x, z);
  const side = p.lateralOffset >= 0 ? 1 : -1;
  const mag = Math.abs(p.lateralOffset);
  const lo = MEDIAN_HALF + WALL_PAD, hi = EDGE - WALL_PAD;
  const clamped = Math.max(lo, Math.min(hi, mag));
  const c = sample(p.s);
  // right-hand normal of increasing-s travel
  const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
  return {
    x: c.x + rx * side * clamped,
    z: c.z + rz * side * clamped,
    hitWall: clamped !== mag,
  };
}

/** on-ramp pose: LONG (dir=1) in the outer carriageway going increasing-s,
 *  SHORT (dir=−1) in the inner carriageway going the other way. Stationary. */
export function spawnPose(dir: 1 | -1): DriveState {
  const s0 = 60; // partway down the east straight
  const c = sample(s0);
  const lat = dir * (MEDIAN_HALF + LANE_W / 2); // inner lane of your carriageway
  const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
  const heading = dir === 1 ? c.heading : c.heading + Math.PI;
  return { x: c.x + rx * lat, z: c.z + rz * lat, heading, speed: 0, steer: 0 };
}
```

- [ ] **Step 1.4: Run the tests to verify they pass**

Run: `cd redline3d && npx vitest run src/core/track.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 1.5: Commit**

```bash
git add redline3d/src/core/track.ts redline3d/src/core/track.test.ts
git commit -m "feat(client): highway track core — stadium centerline, projection, median-walled contain, spawn"
```

---

### Task 2: `highway-gears.ts` — speed → leverage ladder (pure, TDD)

**Files:**
- Create: `redline3d/src/core/highway-gears.ts`
- Create: `redline3d/src/core/highway-gears.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `redline3d/src/core/highway-gears.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GEARS, HW_MAX_LEV, shiftGear, levOf } from "./highway-gears";

describe("gear ladder", () => {
  it("spans the program floor (10×) to the mode cap (100×), monotonic", () => {
    expect(GEARS[0]).toBe(10);
    expect(GEARS[GEARS.length - 1]).toBe(100);
    expect(HW_MAX_LEV).toBe(100);
    for (let i = 1; i < GEARS.length; i++) expect(GEARS[i]).toBeGreaterThan(GEARS[i - 1]);
  });

  it("levOf clamps out-of-range gears", () => {
    expect(levOf(-1)).toBe(10);
    expect(levOf(999)).toBe(100);
  });
});

describe("shiftGear", () => {
  const N = GEARS.length;

  it("stopped car sits in gear 0 (10×)", () => {
    expect(shiftGear(0, 0)).toBe(0);
    expect(levOf(shiftGear(0, 0))).toBe(10);
  });

  it("flat out reaches top gear (100×)", () => {
    expect(shiftGear(0, 1)).toBe(N - 1);
    expect(levOf(N - 1)).toBe(100);
  });

  it("upshifts only past the boundary + hysteresis", () => {
    const boundary = 1 / N;
    expect(shiftGear(0, boundary + 0.001)).toBe(0);  // inside the dead band → hold
    expect(shiftGear(0, boundary + 0.05)).toBe(1);   // clearly past → shift
  });

  it("does not flicker across a boundary (hysteresis)", () => {
    const boundary = 2 / N;
    let g = shiftGear(0, boundary + 0.05); // → gear 2
    expect(g).toBe(2);
    g = shiftGear(g, boundary - 0.01); // small dip back below the raw boundary → hold
    expect(g).toBe(2);
    g = shiftGear(g, boundary - 0.05); // clearly below → downshift
    expect(g).toBe(1);
  });

  it("jumps multiple gears in one call when speed changes a lot", () => {
    expect(shiftGear(0, 0.99)).toBe(N - 1);
    expect(shiftGear(N - 1, 0)).toBe(0);
  });

  it("clamps a malformed current gear", () => {
    expect(shiftGear(-3, 0)).toBe(0);
    expect(shiftGear(99, 1)).toBe(N - 1);
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `cd redline3d && npx vitest run src/core/highway-gears.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement `highway-gears.ts`**

Create `redline3d/src/core/highway-gears.ts`:

```ts
/** Highway mode's speed→leverage ladder. Gear g is active while speedFrac sits in
 *  [g/N, (g+1)/N); HYST widens each boundary so leverage doesn't flicker (every gear
 *  change is a real on-chain lever = a rebank). 10 is the program's leverage floor;
 *  100 is this mode's cap — regardless of car or upgrades. */
export const GEARS = [10, 20, 35, 50, 75, 100] as const;
export const HW_MAX_LEV = GEARS[GEARS.length - 1];
const N = GEARS.length;
const HYST = 0.035;

const clampGear = (g: number) => Math.max(0, Math.min(N - 1, Math.floor(g)));

/** next gear given the current gear and |speed|/MAX_FWD ∈ [0,1] — hysteresis both ways */
export function shiftGear(cur: number, speedFrac: number): number {
  let g = clampGear(cur);
  const f = Math.max(0, Math.min(1, speedFrac));
  while (g < N - 1 && f >= (g + 1) / N + HYST) g++;
  while (g > 0 && f < g / N - HYST) g--;
  return g;
}

export const levOf = (gear: number): number => GEARS[clampGear(gear)];
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `cd redline3d && npx vitest run src/core/highway-gears.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add redline3d/src/core/highway-gears.ts redline3d/src/core/highway-gears.test.ts
git commit -m "feat(client): highway gear ladder — speed→leverage 10..100× with hysteresis"
```

---

### Task 3: HIGHWAY gate in the lobby

Add a fifth building kind. The gate reuses the existing start-gantry builder (`buildTrack`) with its own color/name — no new 3D work.

**Files:**
- Modify: `redline3d/src/core/lobby-layout.ts` (kind union + arc entry)
- Modify: `redline3d/src/core/lobby-layout.test.ts` (KINDS list)
- Modify: `redline3d/src/render/buildings/index.ts` (switch case)

- [ ] **Step 3.1: Update the layout test first**

In `redline3d/src/core/lobby-layout.test.ts`, change the KINDS line:

```ts
const KINDS: BuildingKind[] = ["garage", "upgrades", "crates", "track", "highway"];
```

Run: `cd redline3d && npx vitest run src/core/lobby-layout.test.ts`
Expected: FAIL — `"highway"` is not assignable to `BuildingKind` (type error) or the one-per-kind assertion fails.

- [ ] **Step 3.2: Add the kind and the arc entry**

In `redline3d/src/core/lobby-layout.ts`:

```ts
export type BuildingKind = "garage" | "upgrades" | "crates" | "track" | "highway";
```

and append to `ARC_SPEC` (after the `track` entry):

```ts
  { kind: "highway", deg: 81, w: 30, d: 12, color: 0x27ff9d, name: "HIGHWAY" },
```

(deg 81 puts it at ≈(71, 4) on the arc's east end — inside `LOT_BOUNDS`, door ≥20 units from the TRACK door; the existing bounds/overlap tests verify this.)

- [ ] **Step 3.3: Route the builder**

In `redline3d/src/render/buildings/index.ts`, add to the switch:

```ts
    case "highway": return buildTrack(color, track); // same start-gantry look, its own color/sign
```

- [ ] **Step 3.4: Run the layout tests + compile**

Run: `cd redline3d && npx vitest run src/core/lobby-layout.test.ts && npm run build`
Expected: tests PASS; build clean. (If `main.ts`'s `triggerBuilding` switch now fails exhaustiveness, add a temporary `case "highway": break;` — Task 5 replaces it.)

- [ ] **Step 3.5: Commit**

```bash
git add redline3d/src/core/lobby-layout.ts redline3d/src/core/lobby-layout.test.ts redline3d/src/render/buildings/index.ts redline3d/src/main.ts
git commit -m "feat(client): HIGHWAY gate on the lobby arc (reuses the start-gantry builder)"
```

---

### Task 4: `render/oval.ts` — the track world

Mirrors `render/lobby.ts` structure exactly: `group/show/hide/setRemoteCars/update/dispose`, a `track()` disposal helper, hidden by default. Geometry is built by sampling `sample(s)` from `core/track.ts`. No unit test (renderer precedent); gate is `npm run build` + browser in Task 7.

**Files:**
- Create: `redline3d/src/render/oval.ts`

- [ ] **Step 4.1: Implement the module**

Create `redline3d/src/render/oval.ts`:

```ts
import * as THREE from "three";
import { TRACK, LEN, sample } from "../core/track";

export interface OvalRemoteCar { id: string; x: number; z: number; heading: number; dir: 1 | -1 | 0 }

export interface Oval {
  group: THREE.Group;
  show(): void;
  hide(): void;
  /** ghost cars (Phase 2 presence feeds this; [] today) */
  setRemoteCars(states: OvalRemoteCar[]): void;
  /** trackside billboard text (asset + live price) — cheap CanvasTexture redraw */
  setBillboard(line1: string, line2: string): void;
  update(dt: number): void;
  dispose(): void;
}

const { R, STRAIGHT, MEDIAN_HALF, EDGE } = TRACK;

/** a flat ribbon between two lateral offsets, sampled along the whole loop */
function ribbonGeometry(latA: number, latB: number, y: number, step = 4): THREE.BufferGeometry {
  const n = Math.ceil(LEN / step);
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const c = sample((i / n) * LEN);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    pos.push(c.x + rx * latA, y, c.z + rz * latA, c.x + rx * latB, y, c.z + rz * latB);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function createOval(): Oval {
  const group = new THREE.Group();
  group.visible = false;
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  // ground + neon grid (same palette as the lobby lot)
  const groundGeo = track(new THREE.PlaneGeometry(900, 700));
  const groundMat = track(new THREE.MeshStandardMaterial({ color: 0x0a0820, metalness: 0.55, roughness: 0.45 }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05;
  group.add(ground);
  const grid = new THREE.GridHelper(760, 76, 0xff4dd2, 0x6a2bd9);
  const gm = grid.material as THREE.Material & { opacity: number };
  gm.transparent = true; gm.opacity = 0.28;
  grid.position.y = -0.02;
  group.add(grid);

  // asphalt: both carriageways in one ribbon (median sits on top)
  const roadMat = track(new THREE.MeshStandardMaterial({ color: 0x0d0d1f, metalness: 0.3, roughness: 0.7 }));
  group.add(new THREE.Mesh(track(ribbonGeometry(-EDGE, EDGE, 0)), roadMat));

  // raised median + its amber edge lines (the hard barrier down the middle)
  const medianMat = track(new THREE.MeshStandardMaterial({ color: 0x1a1133, emissive: 0xffb02e, emissiveIntensity: 0.12 }));
  const median = new THREE.Mesh(track(ribbonGeometry(-MEDIAN_HALF, MEDIAN_HALF, 0.22)), medianMat);
  group.add(median);
  const amberMat = track(new THREE.MeshBasicMaterial({ color: 0xffb02e }));
  group.add(new THREE.Mesh(track(ribbonGeometry(-MEDIAN_HALF - 0.35, -MEDIAN_HALF, 0.24)), amberMat));
  group.add(new THREE.Mesh(track(ribbonGeometry(MEDIAN_HALF, MEDIAN_HALF + 0.35, 0.24)), amberMat));

  // outer edge lines (cyan) on both sides
  const cyanMat = track(new THREE.MeshBasicMaterial({ color: 0x2de2e6 }));
  group.add(new THREE.Mesh(track(ribbonGeometry(EDGE - 0.35, EDGE, 0.03)), cyanMat));
  group.add(new THREE.Mesh(track(ribbonGeometry(-EDGE, -EDGE + 0.35, 0.03)), cyanMat));

  // dashed lane dividers: one per carriageway at lat ±(MEDIAN_HALF + LANE_W)
  const dashMat = track(new THREE.MeshBasicMaterial({ color: 0x9ad7ff }));
  const dashGeo = track(new THREE.PlaneGeometry(0.35, 3));
  const laneLat = MEDIAN_HALF + TRACK.LANE_W;
  const dashCount = Math.floor(LEN / 9);
  const dashes = new THREE.InstancedMesh(dashGeo, dashMat, dashCount * 2);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  let di = 0;
  for (let i = 0; i < dashCount; i++) {
    const c = sample((i / dashCount) * LEN);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    for (const side of [1, -1]) {
      // plane lies flat (rotated −90° around X), long axis along the travel direction
      q.setFromAxisAngle(up, -c.heading).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      m4.compose(new THREE.Vector3(c.x + rx * laneLat * side, 0.03, c.z + rz * laneLat * side), q, new THREE.Vector3(1, 1, 1));
      dashes.setMatrixAt(di++, m4);
    }
  }
  group.add(dashes);

  // outer barrier: low glowing wall segments (instanced), like the lobby's perimeter
  const wallMat = track(new THREE.MeshStandardMaterial({ color: 0x180a30, emissive: 0xff4dd2, emissiveIntensity: 0.55 }));
  const wallGeo = track(new THREE.BoxGeometry(0.6, 1.6, 6.4));
  const wallCount = Math.floor(LEN / 6);
  const walls = new THREE.InstancedMesh(wallGeo, wallMat, wallCount * 2);
  let wi = 0;
  for (let i = 0; i < wallCount; i++) {
    const c = sample((i / wallCount) * LEN);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    for (const side of [1, -1]) {
      q.setFromAxisAngle(up, -c.heading);
      m4.compose(new THREE.Vector3(c.x + rx * (EDGE + 0.6) * side, 0.8, c.z + rz * (EDGE + 0.6) * side), q, new THREE.Vector3(1, 1, 1));
      walls.setMatrixAt(wi++, m4);
    }
  }
  group.add(walls);

  // lamp posts every ~48m outside the barrier: violet pole + magenta bar (emissive only)
  const poleMat = track(new THREE.MeshStandardMaterial({ color: 0x160f2e, emissive: 0x5a3fd6, emissiveIntensity: 0.8 }));
  const barMat = track(new THREE.MeshStandardMaterial({ color: 0x2a0f24, emissive: 0xff2d95, emissiveIntensity: 1.6 }));
  const poleGeo = track(new THREE.CylinderGeometry(0.18, 0.18, 7, 6));
  const barGeo = track(new THREE.BoxGeometry(2.6, 0.28, 0.28));
  const lampCount = Math.floor(LEN / 48);
  for (let i = 0; i < lampCount; i++) {
    const c = sample((i / lampCount) * LEN);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    for (const side of [1, -1]) {
      const px = c.x + rx * (EDGE + 3.4) * side, pz = c.z + rz * (EDGE + 3.4) * side;
      const pole = new THREE.Mesh(poleGeo, poleMat); pole.position.set(px, 3.5, pz); group.add(pole);
      const bar = new THREE.Mesh(barGeo, barMat); bar.position.set(px, 7.1, pz); bar.rotation.y = -c.heading; group.add(bar);
    }
  }

  // trackside price billboard (east straight, outside the barrier)
  const bbCanvas = document.createElement("canvas");
  bbCanvas.width = 512; bbCanvas.height = 256;
  const bbTex = track(new THREE.CanvasTexture(bbCanvas));
  const drawBillboard = (l1: string, l2: string) => {
    const g = bbCanvas.getContext("2d")!;
    g.fillStyle = "#0c0a18"; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = "#2de2e6"; g.lineWidth = 8; g.strokeRect(6, 6, 500, 244);
    g.textAlign = "center"; g.font = "700 72px 'Chakra Petch', ui-monospace, monospace";
    g.fillStyle = "#2de2e6"; g.fillText(l1, 256, 104);
    g.fillStyle = "#35ff9d"; g.fillText(l2, 256, 200);
    bbTex.needsUpdate = true;
  };
  drawBillboard("PERPS", "RAIDER");
  const bbMat = track(new THREE.MeshBasicMaterial({ map: bbTex }));
  const bbGeo = track(new THREE.PlaneGeometry(22, 11));
  const bb = new THREE.Mesh(bbGeo, bbMat);
  bb.position.set(R + EDGE + 12, 9, 20);
  bb.rotation.y = -Math.PI / 2; // face the east straight (toward −x)
  group.add(bb);
  const bbPoleGeo = track(new THREE.CylinderGeometry(0.35, 0.35, 7, 6));
  for (const dz of [-8, 8]) {
    const p = new THREE.Mesh(bbPoleGeo, poleMat); p.position.set(R + EDGE + 12, 3.5, 20 + dz); group.add(p);
  }

  // ambient fill (the lobby does the same)
  group.add(new THREE.AmbientLight(0x6a4cff, 0.5));

  // ghost cars — same shape as the lobby seam, tinted by direction
  const remoteGroup = new THREE.Group(); group.add(remoteGroup);
  const remoteMap = new Map<string, THREE.Mesh>();
  const remoteGeo = track(new THREE.BoxGeometry(3.6, 1.6, 7));
  const matLong = track(new THREE.MeshStandardMaterial({ color: 0x11261c, emissive: 0x35ff9d, emissiveIntensity: 0.5, transparent: true, opacity: 0.85 }));
  const matShort = track(new THREE.MeshStandardMaterial({ color: 0x2a0f1c, emissive: 0xff5a7a, emissiveIntensity: 0.5, transparent: true, opacity: 0.85 }));
  const matIdle = track(new THREE.MeshStandardMaterial({ color: 0x222233, emissive: 0x4da6ff, emissiveIntensity: 0.4, transparent: true, opacity: 0.85 }));

  return {
    group,
    show() { group.visible = true; },
    hide() { group.visible = false; },
    setRemoteCars(states) {
      const seen = new Set<string>();
      for (const s of states) {
        seen.add(s.id);
        let m = remoteMap.get(s.id);
        if (!m) { m = new THREE.Mesh(remoteGeo, matIdle); remoteGroup.add(m); remoteMap.set(s.id, m); }
        m.material = s.dir === 1 ? matLong : s.dir === -1 ? matShort : matIdle;
        m.position.set(s.x, 0.9, s.z); m.rotation.y = -s.heading;
      }
      for (const [id, m] of remoteMap) if (!seen.has(id)) { remoteGroup.remove(m); remoteMap.delete(id); }
    },
    setBillboard(l1, l2) { drawBillboard(l1, l2); },
    update(_dt) {},
    dispose() {
      for (const d of disposables) d.dispose();
      remoteMap.clear();
    },
  };
}
```

- [ ] **Step 4.2: Compile gate**

Run: `cd redline3d && npm run build`
Expected: clean (`tsc --noEmit` + vite build succeed).

- [ ] **Step 4.3: Commit**

```bash
git add redline3d/src/render/oval.ts
git commit -m "feat(client): oval highway world — ribbon road, walled median, lane dashes, barriers, lamps, billboard, ghost seam"
```

---

### Task 5: `main.ts` — highway mode wiring (enter/exit + free driving, no money yet)

After this task you can enter the highway from the lobby, drive the loop with walls working, and come back — with the round machinery untouched.

**Files:**
- Modify: `redline3d/src/main.ts`

All anchors below are as of commit `7b884c7` + Task 3; line numbers are approximate — match on the quoted code.

- [ ] **Step 5.1: Imports and construction**

Below the `createLobby` import block (`src/main.ts:39-44`), add:

```ts
import { createOval } from "./render/oval";
import { spawnPose, HW_BOUNDS } from "./core/track";
import { shiftGear, levOf, HW_MAX_LEV } from "./core/highway-gears";
```

Below `const lobbyCam = createLobbyCam();` (near `src/main.ts:249`), add:

```ts
const oval = createOval();
ctx.scene.add(oval.group);
let hwGear = 0; // current highway gear (index into GEARS)
```

Change the mode declaration (`src/main.ts:250`):

```ts
let mode: "race" | "lobby" | "highway" = "race";
```

- [ ] **Step 5.2: Enter/exit functions**

After `exitLobby()` (ends near `src/main.ts:295`), add:

```ts
// ── highway: the free-drive divided oval (spec 2026-07-02) ─────────────────
// Direction is picked at GO and locked; speed drives the 10..100× gear ladder.
function enterHighway() {
  if (engine.getPhase() === "live" || roundActive) return;
  mode = "highway";
  drive = spawnPose(controls.dir());
  hwGear = 0;
  lobby.hide(); lobbyHud.hide(); lobbyHud.setPrompt(null);
  world.group.visible = false;
  pickups.group.visible = false;
  oval.show();
  setRaceHudVisible(true);
  mapBtn.setVisible(true); // "map" = back to the lobby town
  tach.rebuild(HW_MAX_LEV); // the tach reads the gear ladder, not the racer's RMAX
  // racer-only ability buttons are meaningless here — the gear ladder owns leverage
  nitro.setEnabled(false); flux.setEnabled(false); autoExit.setEnabled(false);
  audio.resume(); radio.resume();
}

function exitHighwayToLobby() {
  if (engine.getPhase() === "live" || roundActive) return;
  oval.hide();
  tach.rebuild(effRmax());
  setAbility(ability); // restore the car's own buttons/toggles
  enterLobby();
}
```

NOTE: `enterHighway` is defined after `setAbility`, `tach`, `nitro`, `flux`, `autoExit` exist (they're created earlier in the file) but is only *called* from `triggerBuilding`/`mapBtn`, so hoisting is not an issue.

- [ ] **Step 5.3: Route the gate + the map button**

In `triggerBuilding` (`src/main.ts:298-305`), replace any temporary `case "highway"` from Task 3 with:

```ts
    case "highway": lobbyHud.hide(); enterHighway(); break;       // the free-drive oval
```

Replace the `mapBtn` creation (`src/main.ts:307-310`) with:

```ts
const mapBtn = createMapButton(hudRoot, () => {
  if (mode === "race") enterLobby();
  else if (mode === "highway") exitHighwayToLobby();
});
```

- [ ] **Step 5.4: Make the highway drivable any time (hold-to-drive gate)**

In the canvas `pointerdown` handler (`src/main.ts:346-352`), change the guard line:

```ts
  if (mode === "race" && engine.getPhase() !== "live") return; // showroom: no driving until live (lobby + highway are always drivable)
```

- [ ] **Step 5.5: Extract the shared price-feed block**

Just above `function frame()` (near `src/main.ts:532`), add:

```ts
// One price update per frame, shared by the race and highway branches: eases the display
// price, feeds the HUD + minimap history, and returns the settle-safe round price
// (spec §9: never settle P&L on a stale feed).
function samplePrice(): number {
  const price = priceSource.price();
  const live = priceSource.live();
  if (live && price > 0) lastLivePrice = price;
  if (price > 0) solSmooth = solSmooth ? solSmooth + (price - solSmooth) * 0.1 : price;
  if (solSmooth > 0) solEMA = solEMA ? solEMA + (solSmooth - solEMA) * 0.012 : solSmooth;
  hud.setPrice(solSmooth || price, live);
  if (solUsd > 0) hud.setSolUsd(solUsd);
  if (solSmooth > 0) { priceHist.push(solSmooth); if (priceHist.length > 300) priceHist.shift(); }
  return live ? price : lastLivePrice || price;
}
```

Then in the race path, replace the original block (`src/main.ts:580-592` — from `const price = priceSource.price();` through `const roundPrice = live ? price : lastLivePrice || price;`) with:

```ts
  const roundPrice = samplePrice();
```

(The race branch reads only `roundPrice`, `solSmooth`, `solEMA` after this point — verify with a quick grep for `price`/`live` uses between the old block and `const drivable`.)

- [ ] **Step 5.6: The highway frame branch**

Immediately after the lobby branch's closing `return;` (`src/main.ts:577-578`), add:

```ts
  if (mode === "highway") {
    // same input model as the lobby: hold+drag or WASD
    const kSteer = controls.steer();
    const gas = holding || controls.gas();
    const brake = touchBrake || controls.brake();
    const th = brake ? -1 : gas ? 1 : 0;
    const steer = Math.max(-1, Math.min(1, (holding ? steerNorm : 0) + kSteer));
    drive = driveStep(drive, { throttle: th, steer }, dt, HW_BOUNDS);
    // the median and outer barrier are the real walls (track-shaped contain)
    const c = contain(drive.x, drive.z);
    drive = c.hitWall ? { ...drive, x: c.x, z: c.z, speed: 0 } : { ...drive, x: c.x, z: c.z };

    car.update(dt, drive.speed);
    car.group.position.set(drive.x, 0, drive.z);
    car.group.rotation.set(0, -drive.heading, 0); // same mirror convention as the lobby
    car.setSteer(drive.steer / DRIVE.MAX_STEER_LOW);

    const roundPrice = samplePrice();
    const nowMs = Date.now();

    // speed → gear → leverage (the ladder is the only leverage source in this mode)
    const speedFrac = Math.abs(drive.speed) / DRIVE.MAX_FWD;
    hwGear = shiftGear(hwGear, speedFrac);
    const lev = levOf(hwGear);
    tach.setThrottle(speedFrac, lev);
    audio.engine(speedFrac, true);

    if (engine.getPhase() === "live") {
      game.lev = lev;
      engine.setLeverage(lev, roundPrice);   // instant local rebank (no-op if unchanged)
      session.noteLeverage(lev);             // coalesced on-chain lever (no-op if unchanged)
      const snap = engine.snapshot(roundPrice, nowMs);
      game.equity = snap.equity;
      hud.setMultiplier(Math.max(0, snap.equity), "live");
      controls.setBuffer(Math.max(0, Math.min(1, snap.buffer)));
      controls.setLive(true, `${snap.equity >= 1 ? "CASH OUT" : "BAIL"} ${sol3(snap.payout)}`, snap.equity < 1);
      hud.setTimer(roundMaxSec - (nowMs - roundStartMs) / 1000, true);
      car.setEquity("live", Math.max(0, snap.equity));
      // local time-cap backstop, same as the race branch
      if (roundActive && !settling && (nowMs - roundStartMs) / 1000 >= roundMaxSec) void closeRound("expire");
    } else {
      car.setEquity("idle", 1);
      hud.setTimer(effMaxSec(), false);
    }

    const liqPx = engine.getPhase() === "live" ? liqPriceOf(round.entryPx, round.dir, game.lev, CONFIG.LIQ) : 0;
    minimap.draw({ hist: priceHist, inRun: engine.getPhase() === "live", equity: game.equity, entryPx: round.entryPx, liqPx, dir: round.dir });

    oval.update(dt);
    // ghost seam — Phase 2 replaces this with live presence; the window var is the
    // Preview verification hook (persists across frames, unlike a one-shot call)
    oval.setRemoteCars(((window as any).__hwGhostStates as import("./render/oval").OvalRemoteCar[] | undefined) ?? []);
    lobbyCam.update(ctx.camera, dt, drive.x, drive.z, drive.heading);

    if (post) post.render();
    else ctx.renderer.render(ctx.scene, ctx.camera);
    requestAnimationFrame(frame);
    return;
  }
```

Also add `contain` to the track import in Step 5.1's import line:

```ts
import { spawnPose, contain, HW_BOUNDS } from "./core/track";
```

- [ ] **Step 5.7: DEV-only debug seam for Claude Preview**

Claude Preview runs rAF at ~1.5fps — driving to the lobby gate live is impractical (see memory: verify via DOM state). Add a dev seam at the very bottom of `main.ts` (after `authGate.onSignIn(...)`):

```ts
// DEV-only hooks so browser verification can jump between modes without driving
// across the lobby at Preview's throttled frame rate. Stripped from prod builds.
if (import.meta.env.DEV) {
  (window as any).__hw = {
    enterHighway, exitHighwayToLobby, enterLobby,
    // sets the persistent override the frame loop reads (a direct setRemoteCars call
    // would be wiped by the very next frame)
    ghosts: (states: import("./render/oval").OvalRemoteCar[] | undefined) => { (window as any).__hwGhostStates = states; },
    state: () => ({ mode, hwGear, lev: levOf(hwGear), x: drive.x, z: drive.z, speed: drive.speed }),
  };
}
```

- [ ] **Step 5.8: Compile + full suite**

Run: `cd redline3d && npm run build && npm test`
Expected: both clean. (No behavior change to existing tests — the race branch only had its price block extracted.)

- [ ] **Step 5.9: Commit**

```bash
git add redline3d/src/main.ts
git commit -m "feat(client): highway mode — enter/exit via lobby gate, free-drive on the oval, gear tach, price HUD"
```

---

### Task 6: `main.ts` — GO on the highway (money wiring)

**Files:**
- Modify: `redline3d/src/main.ts` (the `controls.onLaunch` handler, `src/main.ts:428-509`)

- [ ] **Step 6.1: Open at gear 0 from the chosen side**

In `controls.onLaunch`, change the leverage line (`src/main.ts:458`):

```ts
    const dir = controls.dir();
    // Highway: you pull onto the road from a stop — open in bottom gear (10×); the ladder
    // takes it from there. Racer: the throttle's live leverage, on-chain RMAX=3000.
    const lev = mode === "highway" ? levOf(0) : clampInt(game.lev, 10, 3000);
```

- [ ] **Step 6.2: Spawn into the chosen carriageway + gate the racer-only bits**

After `engine.launch({...})` / `roundActive = true;` (`src/main.ts:498-499`), adjust the block:

```ts
    engine.launch({ dir, lev, stake: playAmount, entryRaw: opened.entryHuman, startMs: roundStartMs, maxSec: roundMaxSec });
    roundActive = true;
    nearDeath = false; deathsDoor.clear();
    autoExit.setLive(true);
    if (mode === "highway") {
      // locked direction = locked carriageway: respawn on the on-ramp of your side
      drive = spawnPose(dir);
      hwGear = 0;
      game.lev = lev;
    } else {
      chase.setDriving(true);
    }
    controls.setLive(true, "CASH OUT");
```

(That replaces the unconditional `chase.setDriving(true);` at `src/main.ts:502`. Everything else in the handler — `ensureSession`, error paths, `garage.setBusy(true)` etc. — stays exactly as is.)

- [ ] **Step 6.3: Compile + suite**

Run: `cd redline3d && npm run build && npm test`
Expected: clean.

- [ ] **Step 6.4: Commit**

```bash
git add redline3d/src/main.ts
git commit -m "feat(client): highway GO — open at bottom gear on the picked side, spawn into the locked carriageway"
```

---

### Task 7: Billboard live price

**Files:**
- Modify: `redline3d/src/main.ts` (highway frame branch from Task 5.6)

- [ ] **Step 7.1: Feed the billboard at ~2Hz**

In the highway frame branch, right after `const roundPrice = samplePrice();`, add:

```ts
    // trackside billboard: the same feed the round settles against, made physical
    hwBillboardCd -= dt;
    if (hwBillboardCd <= 0) {
      hwBillboardCd = 0.5;
      const px = solSmooth || roundPrice;
      oval.setBillboard(asset, px > 0 ? px.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—");
    }
```

and declare the cooldown next to `let hwGear = 0;` (Task 5.1):

```ts
let hwBillboardCd = 0; // billboard redraw cooldown (CanvasTexture upload ≈ not free)
```

- [ ] **Step 7.2: Compile, commit**

Run: `cd redline3d && npm run build`
Expected: clean.

```bash
git add redline3d/src/main.ts
git commit -m "feat(client): highway billboard shows the live settle feed (asset + price)"
```

---

### Task 8: Browser verification on devnet (MANDATORY before Phase 1 is "done")

Per project memory: tsc/tests passing ≠ working — the mode must be seen running in Claude Preview against devnet, and two past defects were only ever caught this way.

**Files:** none (verification). Uses the existing `redline3d` launch config (Preview forces the dev keypair via launch.json).

- [ ] **Step 8.1: Start the preview** — `preview_start` name `redline3d`. If the page was cached from before this branch's changes, `preview_stop` + `preview_start` to bust the module cache (known gotcha).
- [ ] **Step 8.2: Sign in** through the auth gate (dev keypair port is forced in Preview).
- [ ] **Step 8.3: Enter the highway.** Preferred: map button → lobby → confirm the HIGHWAY gantry + sign render on the arc's east end (screenshot). Then jump: `preview_eval` → `window.__hw.enterHighway()` (driving to the gate at 1.5fps is impractical; the gate's door-trigger path is the same `triggerBuilding` switch, verified by the lobby-layout tests).
- [ ] **Step 8.4: Solo drive checks** via `preview_eval` polling `window.__hw.state()`:
  - dispatch W-key `keydown` (KeyboardEvent) for ~2s → `speed` rises, `mode === "highway"` stays, position moves along the straight;
  - hold long enough → `lev` climbs through the ladder (10 → 20 → …) and the tach label matches;
  - steer into the median (A/D) → position clamps, speed zeroes (wall hit).
- [ ] **Step 8.5: Money happy path (devnet):** pick SHORT in the call box, press GO → status walks through "Getting on track…"/"Launching…"; confirm `window.__hw.state().lev === 10` at open and the car respawned in the inner carriageway heading the other way; drive to shift gears → on-chain lever lands (watch the HUD × and `session` logs in `preview_console_logs`); confirm the LONG/SHORT box is non-interactive while live; CASH OUT → settles with the banked amount in the status line; wallet panel End/withdraw path untouched.
- [ ] **Step 8.6: Exit path:** map button returns to the lobby (blocked while live — check it no-ops mid-round); TRACK gate still launches the classic racer; racer still plays a normal round (no regression from the `samplePrice` extraction — one full GO→CASH OUT in race mode).
- [ ] **Step 8.7: Ghost seam smoke:** `preview_eval` → `window.__hw.ghosts([{id:"g1",x:66,z:30,heading:0,dir:1},{id:"g2",x:54,z:50,heading:Math.PI,dir:-1}])` → screenshot shows a green ghost in the outer carriageway and a red one oncoming.
- [ ] **Step 8.8: Report** — screenshots + console excerpts in the task summary. Any defect found here gets fixed + re-verified before the phase is called done.

---

## Phase 2 — Ghost presence

### Task 9: `server/presence.mjs` — the relay (TDD)

A ~100-line WebSocket fan-out in the existing `server/` package (it already has vitest). Rooms → member states → 8Hz broadcast. No auth, no persistence: positions are cosmetic; money is on-chain.

**Files:**
- Create: `server/presence.mjs`
- Create: `server/src/presence.test.ts`
- Modify: `server/package.json` (add `ws` dependency + `presence` script)

- [ ] **Step 9.1: Add the dependency and script**

Run: `cd server && npm install ws@8`
In `server/package.json` scripts, add: `"presence": "node presence.mjs"`.

- [ ] **Step 9.2: Write the failing test**

Create `server/src/presence.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { createPresenceServer } from "../presence.mjs";

let srv: { port: number; close(): void };
beforeAll(() => { srv = createPresenceServer(0); });
afterAll(() => srv.close());

function connect(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
const send = (ws: WebSocket, o: unknown) => ws.send(JSON.stringify(o));
function nextPeers(ws: WebSocket, pred: (states: any[]) => boolean): Promise<any[]> {
  return new Promise((res) => {
    const onMsg = (buf: WebSocket.RawData) => {
      const m = JSON.parse(String(buf));
      if (m.t === "peers" && pred(m.states)) { ws.off("message", onMsg); res(m.states); }
    };
    ws.on("message", onMsg);
  });
}

describe("presence relay", () => {
  it("fans a member's state out to the room", async () => {
    const a = await connect(), b = await connect();
    send(a, { t: "join", room: "oval-1", id: "aaa" });
    send(b, { t: "join", room: "oval-1", id: "bbb" });
    send(a, { t: "state", x: 65, z: 40, heading: 0, dir: 1 });
    const states = await nextPeers(b, (s) => s.some((p: any) => p.id === "aaa"));
    const p = states.find((s: any) => s.id === "aaa");
    expect(p).toMatchObject({ x: 65, z: 40, heading: 0, dir: 1 });
    a.close(); b.close();
  });

  it("drops a member from the room on disconnect", async () => {
    const a = await connect(), b = await connect();
    send(a, { t: "join", room: "oval-2", id: "gone" });
    send(b, { t: "join", room: "oval-2", id: "stay" });
    send(a, { t: "state", x: 1, z: 1, heading: 0, dir: 0 });
    await nextPeers(b, (s) => s.some((p: any) => p.id === "gone"));
    a.close();
    await nextPeers(b, (s) => !s.some((p: any) => p.id === "gone"));
    b.close();
  });

  it("isolates rooms and survives malformed messages", async () => {
    const a = await connect(), b = await connect();
    a.send("not json");
    send(a, { t: "join", room: "oval-A", id: "ra" });
    send(b, { t: "join", room: "oval-B", id: "rb" });
    send(a, { t: "state", x: 9, z: 9, heading: 0, dir: 1 });
    // b (room B) must keep receiving peers frames that never contain ra
    const states = await nextPeers(b, () => true);
    expect(states.every((p: any) => p.id !== "ra")).toBe(true);
    a.close(); b.close();
  });
});
```

- [ ] **Step 9.3: Run to verify failure**

Run: `cd server && npx vitest run src/presence.test.ts`
Expected: FAIL — cannot find `../presence.mjs`.

- [ ] **Step 9.4: Implement the relay**

Create `server/presence.mjs`:

```js
// Highway-mode ghost presence: a tiny room-scoped WebSocket fan-out.
// No auth, no persistence — positions are cosmetic; all money stays on-chain.
// A dead relay just means no ghosts; it can never touch a round.
import { WebSocketServer } from "ws";

const TICK_MS = 125; // 8Hz broadcast

export function createPresenceServer(port = 8787) {
  const wss = new WebSocketServer({ port });
  /** room -> Map<id, { ws, state }> */
  const rooms = new Map();

  wss.on("connection", (ws) => {
    let room = null, id = null;
    ws.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(String(buf)); } catch { return; }
      if (msg?.t === "join" && typeof msg.room === "string" && typeof msg.id === "string") {
        room = msg.room; id = msg.id;
        if (!rooms.has(room)) rooms.set(room, new Map());
        rooms.get(room).set(id, { ws, state: null });
      } else if (msg?.t === "state" && room && id) {
        const m = rooms.get(room)?.get(id);
        if (m) m.state = {
          id,
          x: Number(msg.x) || 0,
          z: Number(msg.z) || 0,
          heading: Number(msg.heading) || 0,
          dir: msg.dir === 1 || msg.dir === -1 ? msg.dir : 0,
        };
      }
    });
    ws.on("close", () => {
      if (room && id) {
        const r = rooms.get(room);
        r?.delete(id);
        if (r && r.size === 0) rooms.delete(room);
      }
    });
  });

  const timer = setInterval(() => {
    for (const members of rooms.values()) {
      const states = [...members.values()].map((m) => m.state).filter(Boolean);
      const payload = JSON.stringify({ t: "peers", states });
      for (const m of members.values()) if (m.ws.readyState === 1) m.ws.send(payload);
    }
  }, TICK_MS);

  return {
    get port() { return wss.address().port; },
    close() { clearInterval(timer); for (const c of wss.clients) c.terminate(); wss.close(); },
  };
}

// CLI entry: `npm run presence` (PORT env overrides)
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = createPresenceServer(Number(process.env.PORT ?? 8787));
  console.log(`presence relay on :${process.env.PORT ?? 8787}`);
  process.on("SIGINT", () => { s.close(); process.exit(0); });
}
```

- [ ] **Step 9.5: Run to verify pass**

Run: `cd server && npx vitest run src/presence.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9.6: Commit**

```bash
git add server/presence.mjs server/src/presence.test.ts server/package.json server/package-lock.json
git commit -m "feat(server): highway ghost presence relay — room-scoped ws fan-out at 8Hz"
```

---

### Task 10: `net/presence.ts` — the browser client (TDD)

Throttled latest-wins sender + interpolated peer store + auto-reconnect. Socket factory is injectable so tests run with a fake.

**Files:**
- Create: `redline3d/src/net/presence.ts`
- Create: `redline3d/src/net/presence.test.ts`

- [ ] **Step 10.1: Write the failing tests**

Create `redline3d/src/net/presence.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPresence, type PresenceSocket } from "./presence";

class FakeSocket implements PresenceSocket {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onmessage: ((data: string) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.onclose?.(); }
  open() { this.onopen?.(); }
  receive(o: unknown) { this.onmessage?.(JSON.stringify(o)); }
}

const make = () =>
  createPresence({
    url: "ws://x", room: "oval-1", id: "me",
    makeSocket: (url) => new FakeSocket(url),
    nowMs: () => now,
  });

let now = 0;
beforeEach(() => { now = 0; FakeSocket.instances = []; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("presence client", () => {
  it("joins the room on open", () => {
    const p = make(); p.start();
    const s = FakeSocket.instances[0]; s.open();
    expect(JSON.parse(s.sent[0])).toEqual({ t: "join", room: "oval-1", id: "me" });
    p.stop();
  });

  it("throttles sends to one per interval, latest wins", () => {
    const p = make(); p.start();
    const s = FakeSocket.instances[0]; s.open();
    p.send({ x: 1, z: 0, heading: 0, dir: 1 });
    p.send({ x: 2, z: 0, heading: 0, dir: 1 }); // within the same 125ms window
    const states = s.sent.filter((m) => JSON.parse(m).t === "state");
    expect(states.length).toBe(1);
    expect(JSON.parse(states[0]).x).toBe(1);
    now += 130; vi.advanceTimersByTime(130); // window elapses → queued latest flushes
    const after = s.sent.filter((m) => JSON.parse(m).t === "state");
    expect(after.length).toBe(2);
    expect(JSON.parse(after[1]).x).toBe(2);
    p.stop();
  });

  it("interpolates peers between the last two snapshots (render delay)", () => {
    const p = make(); p.start();
    const s = FakeSocket.instances[0]; s.open();
    now = 1000; s.receive({ t: "peers", states: [{ id: "a", x: 0, z: 0, heading: 0, dir: 1 }] });
    now = 1125; s.receive({ t: "peers", states: [{ id: "a", x: 10, z: 0, heading: 0, dir: 1 }] });
    // render time = now − 150ms; at now=1250 render t=1100 sits inside [1000,1125] → x ≈ 8
    now = 1250;
    const peers = p.peers();
    expect(peers.length).toBe(1);
    expect(peers[0].x).toBeGreaterThan(6);
    expect(peers[0].x).toBeLessThanOrEqual(10);
    p.stop();
  });

  it("filters own id and evicts stale peers", () => {
    const p = make(); p.start();
    const s = FakeSocket.instances[0]; s.open();
    now = 1000;
    s.receive({ t: "peers", states: [{ id: "me", x: 1, z: 1, heading: 0, dir: 1 }, { id: "b", x: 2, z: 2, heading: 0, dir: -1 }] });
    now = 1200;
    expect(p.peers().map((q) => q.id)).toEqual(["b"]);
    now = 4000; // >2s without an update → evicted
    expect(p.peers()).toEqual([]);
    p.stop();
  });

  it("reconnects after a close with backoff", () => {
    const p = make(); p.start();
    const s0 = FakeSocket.instances[0]; s0.open();
    s0.close();
    vi.advanceTimersByTime(1100);
    expect(FakeSocket.instances.length).toBe(2); // a fresh socket was made
    p.stop();
  });

  it("ignores malformed messages", () => {
    const p = make(); p.start();
    const s = FakeSocket.instances[0]; s.open();
    s.onmessage?.("garbage{");
    expect(p.peers()).toEqual([]);
    p.stop();
  });
});
```

- [ ] **Step 10.2: Run to verify failure**

Run: `cd redline3d && npx vitest run src/net/presence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 10.3: Implement the client**

Create `redline3d/src/net/presence.ts`:

```ts
/** Highway ghost presence client: throttled latest-wins sender + interpolated peer
 *  store + auto-reconnect. A dead relay silently means "no ghosts" — never an error
 *  the player sees, never anything that can touch a round. */

export interface PeerState { id: string; x: number; z: number; heading: number; dir: 1 | -1 | 0 }

/** the subset of WebSocket we use — injectable for tests */
export interface PresenceSocket {
  send(data: string): void;
  close(): void;
  onmessage: ((data: string) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
}

export interface Presence {
  start(): void;
  stop(): void;
  /** record the local car's latest state (throttled to SEND_MS on the wire) */
  send(s: Omit<PeerState, "id">): void;
  /** interpolated remote peers at (now − RENDER_DELAY_MS), own id filtered */
  peers(): PeerState[];
}

const SEND_MS = 125;          // ~8Hz out
const RENDER_DELAY_MS = 150;  // render slightly in the past so 8Hz looks smooth
const STALE_MS = 2000;        // no update for 2s → drop the ghost
const BACKOFF0_MS = 1000, BACKOFF_MAX_MS = 8000;

interface Snap { t: number; s: PeerState }

function defaultSocket(url: string): PresenceSocket {
  const ws = new WebSocket(url);
  const shim: PresenceSocket = { send: (d) => ws.send(d), close: () => ws.close(), onmessage: null, onopen: null, onclose: null };
  ws.onmessage = (e) => shim.onmessage?.(String(e.data));
  ws.onopen = () => shim.onopen?.();
  ws.onclose = () => shim.onclose?.();
  ws.onerror = () => { /* onclose follows; reconnect handles it */ };
  return shim;
}

export function createPresence(opts: {
  url: string; room: string; id: string;
  makeSocket?: (url: string) => PresenceSocket;
  nowMs?: () => number;
}): Presence {
  const now = opts.nowMs ?? (() => Date.now());
  const makeSocket = opts.makeSocket ?? defaultSocket;
  let sock: PresenceSocket | null = null;
  let running = false, open = false, backoff = BACKOFF0_MS;
  let lastSendAt = -Infinity;
  let queued: Omit<PeerState, "id"> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const hist = new Map<string, { prev: Snap | null; next: Snap }>();

  function connect() {
    if (!running) return;
    sock = makeSocket(opts.url);
    sock.onopen = () => {
      open = true; backoff = BACKOFF0_MS;
      sock!.send(JSON.stringify({ t: "join", room: opts.room, id: opts.id }));
    };
    sock.onclose = () => {
      open = false; sock = null;
      if (running) {
        setTimeout(connect, backoff);
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
      }
    };
    sock.onmessage = (data) => {
      let msg: any;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg?.t !== "peers" || !Array.isArray(msg.states)) return;
      const t = now();
      for (const s of msg.states) {
        if (!s || typeof s.id !== "string" || s.id === opts.id) continue;
        const cur = hist.get(s.id);
        const snap: Snap = { t, s: { id: s.id, x: +s.x || 0, z: +s.z || 0, heading: +s.heading || 0, dir: s.dir === 1 || s.dir === -1 ? s.dir : 0 } };
        hist.set(s.id, { prev: cur?.next ?? null, next: snap });
      }
    };
  }

  function flush() {
    flushTimer = null;
    if (!open || !sock || !queued) return;
    lastSendAt = now();
    sock.send(JSON.stringify({ t: "state", ...queued }));
    queued = null;
  }

  return {
    start() { if (running) return; running = true; connect(); },
    stop() {
      running = false; open = false;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      queued = null; hist.clear();
      sock?.close(); sock = null;
    },
    send(s) {
      if (!open || !sock) return;
      const since = now() - lastSendAt;
      if (since >= SEND_MS) { lastSendAt = now(); sock.send(JSON.stringify({ t: "state", ...s })); }
      else { queued = s; if (!flushTimer) flushTimer = setTimeout(flush, SEND_MS - since); }
    },
    peers() {
      const t = now() - RENDER_DELAY_MS;
      const out: PeerState[] = [];
      for (const [id, h] of hist) {
        if (now() - h.next.t > STALE_MS) { hist.delete(id); continue; }
        if (!h.prev || t >= h.next.t) { out.push(h.next.s); continue; }
        if (t <= h.prev.t) { out.push(h.prev.s); continue; }
        const f = (t - h.prev.t) / (h.next.t - h.prev.t);
        const a = h.prev.s, b = h.next.s;
        // shortest-arc heading lerp so a ghost crossing ±π doesn't spin
        let dh = b.heading - a.heading;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        out.push({ id, x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, heading: a.heading + dh * f, dir: b.dir });
      }
      return out;
    },
  };
}
```

- [ ] **Step 10.4: Run to verify pass**

Run: `cd redline3d && npx vitest run src/net/presence.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 10.5: Commit**

```bash
git add redline3d/src/net/presence.ts redline3d/src/net/presence.test.ts
git commit -m "feat(client): presence client — throttled sender, interpolated ghosts, silent reconnect"
```

---

### Task 11: Wire ghosts into the highway

**Files:**
- Modify: `redline3d/src/main.ts`
- Modify: `redline3d/.env.example` (or create) — document `VITE_PRESENCE_URL`

- [ ] **Step 11.1: Construct presence (only when configured)**

Next to the `oval` construction (Task 5.1), add:

```ts
// Ghost presence: cosmetic peer cars on the oval. Off unless a relay URL is configured —
// Preview/tests run without it and simply see an empty road.
import { createPresence } from "./net/presence"; // (add to the import block at the top)

const PRESENCE_URL = (import.meta.env.VITE_PRESENCE_URL as string | undefined) ?? "";
const presence = PRESENCE_URL
  ? createPresence({ url: PRESENCE_URL, room: "oval-1", id: crypto.randomUUID().slice(0, 8) })
  : null;
```

- [ ] **Step 11.2: Start/stop with the mode**

In `enterHighway()` add `presence?.start();` (last line). In `exitHighwayToLobby()` add `presence?.stop();` before `enterLobby();`.

- [ ] **Step 11.3: Broadcast + render in the highway frame**

In the highway frame branch, replace the Task-5.6 ghost-seam line (`oval.setRemoteCars(((window as any).__hwGhostStates …) ?? []);` and its comment) with:

```ts
    presence?.send({ x: drive.x, z: drive.z, heading: drive.heading, dir: roundActive ? round.dir : 0 });
    const ghostOverride = (window as any).__hwGhostStates as import("./render/oval").OvalRemoteCar[] | undefined;
    oval.setRemoteCars(ghostOverride ?? presence?.peers() ?? []);
```

(`__hwGhostStates` is the Preview verification seam — a plain window var so `preview_eval` can inject a steady set of ghosts; it wins over live presence when set. DEV-only usage; harmless in prod.)

- [ ] **Step 11.4: Document the env var**

Append to `redline3d/.env.example` (create the file if missing):

```
# Highway-mode ghost presence relay (Phase 2). Empty = no ghosts (mode still works).
# Local: `cd server && npm run presence` then set:
# VITE_PRESENCE_URL=ws://localhost:8787
VITE_PRESENCE_URL=
```

- [ ] **Step 11.5: Compile + suite + commit**

Run: `cd redline3d && npm run build && npm test`
Expected: clean.

```bash
git add redline3d/src/main.ts redline3d/.env.example
git commit -m "feat(client): highway ghosts live — presence wired to the oval seam (env-gated)"
```

---

### Task 12: Phase 2 verification

- [ ] **Step 12.1: Relay + suites green** — `cd server && npx vitest run src/presence.test.ts` and `cd redline3d && npm test`. Expected: all pass.
- [ ] **Step 12.2: Live two-client smoke (headless):** start the relay (`cd server && PORT=8791 npm run presence`); run a small script with two `ws` clients in the same room asserting cross-visibility (this re-uses the Task 9 test path against a real listening port — `cd server && PORT=8791 npx vitest run src/presence.test.ts` is acceptable as the check).
- [ ] **Step 12.3: Browser ghost render:** with `VITE_PRESENCE_URL=ws://localhost:8791` in `redline3d/.env.local` and the relay running, preview_stop/preview_start `redline3d`, sign in, `window.__hw.enterHighway()`, and via a second headless `ws` client (Bash, `node -e` one-liner joining `oval-1` and sending states on a timer) confirm a moving ghost renders on the oval — screenshot. Then kill the relay and confirm the game keeps running with ghosts gone (no console errors beyond the reconnect warnings).
- [ ] **Step 12.4: Report** with screenshots. Real two-human devnet drive = user-run (offer it).

---

## Explicitly out of scope (spec non-goals — do NOT add)

- No mid-round flip of any kind in highway mode (no U-turn detection, no FLIP button, `doFlip` never called there).
- No pit-lane mechanic, no collisions, no authoritative server state.
- No on-chain program changes, no new instructions, no redeploy/migration.
- Racer abilities (nitro/flux/lane-bet/skull/swerve/pinkRod auto-exit) stay racer-only; highway disables their buttons on entry and `setAbility(ability)` restores them on exit.
- No changes to the racer's RMAX/leverage (user directive: never lower it).

## Execution notes

- Commit after every task; never batch tasks into one commit.
- If any step's expected output doesn't match, STOP and debug (superpowers:systematic-debugging) before moving on.
- Task 8 (browser devnet verify) is a hard gate for Phase 1; Task 12 for Phase 2. "Tests pass" alone is not done (project memory).
