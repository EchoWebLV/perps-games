# Crate Reveal — Hearthstone-style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the crate-open reveal so one open shows all its prizes on a single screen — a spinning 3D car (hero), a procedural scrap pile, and a level-skin poster card — with a staged burst→reveal build-up.

**Architecture:** A new self-contained `ui/reveal-car.ts` owns the WebGL car viewer (live spinning canvas on the high tier; one rendered PNG shown as a static `<img>` on the low/Seeker tier). A new pure `ui/reveal-bits.ts` returns the scrap-pile and level-poster markup (unit-tested). `ui/cratebox.ts` composes them in a reskinned `showReveal` and mounts/clears the viewer with the reveal lifecycle. Roll logic in `core/crate.ts` is untouched except a type widening; `main.ts` passes the perf tier and a richer `levelInfo`.

**Tech Stack:** TypeScript, three.js (GLTFLoader, RoomEnvironment, PMREMGenerator), vitest (+ jsdom for DOM tests), Vite. Spec: `docs/superpowers/specs/2026-07-09-crate-reveal-hearthstone-design.md`.

**Verification split:** the worker runs `tsc` + `vitest` (pure tests + full suite). Browser verification of the live reveal (all three tiles via a forced legendary+level, a duplicate, and the low-tier static path) is done by the main session in Claude Preview — NOT the worker.

---

## File Structure

- **Create** `src/ui/reveal-bits.ts` — pure functions: `pileShards(n)`, `scrapPileHtml(n)`, `levelPosterHtml(info)`; type `LevelPoster`. No DOM side effects, no styles (cratebox owns the CSS).
- **Create** `src/ui/reveal-bits.test.ts` — unit tests for the pure functions.
- **Create** `src/ui/reveal-car.ts` — `createRevealCar({ lowTier })` → `{ el, show, clear, dispose }`. Owns the WebGL lifecycle.
- **Modify** `src/core/crate.ts` — widen `CrateCar` with optional `url?/scale?/yaw?`.
- **Modify** `src/ui/cratebox.ts` — deps gain `lowTier`; `levelInfo` returns `LevelPoster`; reskin `showReveal`; tweak `doOpen` choreography; mount/clear the viewer; add reveal CSS.
- **Modify** `src/ui/cratebox.test.ts` — update `stubDeps` for the new `levelInfo` shape + `lowTier`.
- **Modify** `src/main.ts` — pass `lowTier: quality.tier === "low"`; return the richer `levelInfo`.

---

### Task 1: Widen `CrateCar` with the model descriptor

The rolled car object is a `CAR_DEFS` entry that already carries `url/scale/yaw` at runtime; declare them so the viewer can read them type-safely.

**Files:**
- Modify: `src/core/crate.ts:12`

- [ ] **Step 1: Edit the interface**

Change:
```ts
export interface CrateCar { rarity?: number; name: string; pool?: boolean; comingSoon?: boolean; locked?: boolean; }
```
to:
```ts
export interface CrateCar {
  rarity?: number; name: string; pool?: boolean; comingSoon?: boolean; locked?: boolean;
  // model descriptor (present on the CAR_DEFS objects the roll returns) — used by the reveal viewer
  url?: string; scale?: number; yaw?: number;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd redline3d && npx tsc --noEmit`
Expected: PASS (no new errors; `crate.test.ts` uses only `name/rarity/pool`, still valid).

- [ ] **Step 3: Commit**

```bash
git add redline3d/src/core/crate.ts
git commit -m "feat(crate): widen CrateCar with optional model descriptor (url/scale/yaw)"
```

---

### Task 2: Pure reveal helpers — scrap pile + level poster (TDD)

**Files:**
- Create: `src/ui/reveal-bits.ts`
- Test: `src/ui/reveal-bits.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/ui/reveal-bits.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { pileShards, scrapPileHtml, levelPosterHtml, type LevelPoster } from "./reveal-bits";

describe("pileShards — heap size scales with the scrap amount", () => {
  test("more scrap → more shards, clamped to a sane range", () => {
    expect(pileShards(0)).toBe(0);        // nothing → no pile
    expect(pileShards(25)).toBe(4);       // wooden base
    expect(pileShards(300)).toBe(6);      // silver base
    expect(pileShards(800)).toBe(8);      // gold base
    expect(pileShards(5000)).toBe(10);    // clamp
  });
  test("monotonic non-decreasing", () => {
    let prev = -1;
    for (const n of [0, 10, 25, 100, 300, 800, 2000]) { const s = pileShards(n); expect(s).toBeGreaterThanOrEqual(prev); prev = s; }
  });
});

describe("scrapPileHtml", () => {
  test("renders the amount and one shard element per pileShards(n)", () => {
    const html = scrapPileHtml(300);
    expect(html).toContain("+300");
    const shards = (html.match(/cb-shard/g) ?? []).length;
    expect(shards).toBe(pileShards(300));
  });
});

describe("levelPosterHtml", () => {
  const info: LevelPoster = { name: "Neon City", sky: ["#050a24", "#123a6a"], disc: "#9fc0ee", grid: ["#ff39c0", "#27e7ff"] };
  test("shows the skin name and paints from the theme palette", () => {
    const html = levelPosterHtml(info);
    expect(html).toContain("Neon City");
    expect(html).toContain("#123a6a"); // sky
    expect(html).toContain("#9fc0ee"); // celestial disc
    expect(html).toContain("#27e7ff"); // grid
    expect(html).toContain("NEW LEVEL");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd redline3d && npx vitest run src/ui/reveal-bits.test.ts`
Expected: FAIL — "Cannot find module './reveal-bits'".

- [ ] **Step 3: Implement `reveal-bits.ts`**

Create `src/ui/reveal-bits.ts`:
```ts
// Pure markup helpers for the crate reveal. No DOM side effects and no <style> injection
// (cratebox.ts owns the reveal CSS) so these stay trivially unit-testable.

/** the level-skin poster's palette, pulled from a WorldTheme (see main.ts levelInfo). */
export interface LevelPoster { name: string; sky: [string, string]; disc: string; grid: [string, string]; }

/** how many shards the scrap heap draws for an amount — a stepped, clamped feel. */
export function pileShards(n: number): number {
  if (n <= 0) return 0;
  if (n < 100) return 4;
  if (n < 400) return 6;
  if (n < 900) return 8;
  return 10;
}

/** a little pile of steel shards + the amount. Shards are placed deterministically by index
 *  (no RNG → stable in tests); actual look comes from the .cb-shard CSS in cratebox. */
export function scrapPileHtml(n: number): string {
  const count = pileShards(n);
  let shards = "";
  for (let i = 0; i < count; i++) {
    const col = i % 3 === 0 ? "#d7dee7" : i % 3 === 1 ? "#c2cad6" : "#8b93a0";
    const x = ((i * 37) % 70) - 35;            // −35..35 px spread, deterministic
    const y = (i % 3) * 6;                      // 0/6/12 px stacking
    const rot = ((i * 53) % 90) - 45;           // −45..45 deg
    const sz = 12 + (i % 3) * 4;                // 12/16/20 px
    shards += `<span class="cb-shard" style="--sc:${col};left:calc(50% + ${x}px);bottom:${y}px;width:${sz}px;height:${sz}px;transform:translateX(-50%) rotate(${rot}deg)"></span>`;
  }
  return `<div class="cb-scrap"><div class="cb-scrap-heap">${shards}</div><div class="cb-scrap-n">+${n}</div><div class="cb-scrap-lbl">scrap</div></div>`;
}

/** a mini world-poster card built from the theme palette. */
export function levelPosterHtml(info: LevelPoster): string {
  return (
    `<div class="cb-poster">` +
      `<div class="cb-poster-sky" style="background:linear-gradient(180deg,${info.sky[0]},${info.sky[1]})">` +
        `<span class="cb-poster-disc" style="background:${info.disc}"></span>` +
        `<span class="cb-poster-grid" style="background:${info.grid[1]}"></span>` +
        `<span class="cb-poster-grid low" style="background:${info.grid[0]}"></span>` +
      `</div>` +
      `<div class="cb-poster-body"><div class="cb-poster-nm">${info.name}</div><div class="cb-poster-tag">NEW LEVEL</div></div>` +
    `</div>`
  );
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd redline3d && npx vitest run src/ui/reveal-bits.test.ts`
Expected: PASS (3 describes, all green).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/ui/reveal-bits.ts redline3d/src/ui/reveal-bits.test.ts
git commit -m "feat(reveal): pure scrap-pile + level-poster markup helpers (TDD)"
```

---

### Task 3: The 3D car viewer (`reveal-car.ts`)

WebGL, so no vitest — verified by `tsc` here and in the browser later. High tier: a lazily-created persistent canvas that slowly spins the model; low tier: one PNG frame in an `<img>`.

**Files:**
- Create: `src/ui/reveal-car.ts`

- [ ] **Step 1: Create the module**

```ts
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// The crate-reveal car viewer. High tier: a live, slowly spinning 3D model in its own small
// WebGL canvas (lazily created on first show). Low tier (weak GPU): one rendered frame shown as
// a static <img> — zero live GPU during the reveal. Mirrors the transient renderer in
// cratebox.ts (low) and the garage turntable (high). `el` is a stable container either way.
export interface RevealCar {
  el: HTMLElement;
  show(opts: { url: string; scale?: number; yaw?: number; tierColor: string }): void;
  clear(): void;
  dispose(): void;
}

const SIZE = 220;
const pr = () => Math.min(2, window.devicePixelRatio || 1);

function makeCam(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  c.position.set(2.0, 1.5, 2.6); c.lookAt(0, -0.05, 0);
  return c;
}
// normalize any car to a unit bounding sphere (consistent on-screen size), apply its facing yaw,
// then centre it at the origin.
function frameModel(model: THREE.Object3D, yaw: number): void {
  model.rotation.y = yaw;
  const sph = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
  model.scale.setScalar(1 / (sph.radius || 1));
  const ctr = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
  model.position.set(-ctr.x, -ctr.y, -ctr.z);
}
function disposeModel(o: THREE.Object3D): void {
  o.traverse((n) => { const m = n as THREE.Mesh; if (m.isMesh) { m.geometry?.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm?.dispose()); } });
}

export function createRevealCar({ lowTier }: { lowTier: boolean }): RevealCar {
  const loader = new GLTFLoader();
  let loadGen = 0;
  const el = document.createElement("div");
  el.style.cssText = `width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center`;

  if (lowTier) {
    const img = document.createElement("img");
    img.width = SIZE; img.height = SIZE; img.style.cssText = `width:${SIZE}px;height:${SIZE}px;object-fit:contain`;
    el.appendChild(img);
    return {
      el,
      show({ url, yaw = 0, tierColor }) {
        const gen = ++loadGen;
        loader.load(url, (gltf) => {
          if (gen !== loadGen) return;
          const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
          r.setPixelRatio(pr()); r.setSize(SIZE, SIZE, false);
          const pmrem = new THREE.PMREMGenerator(r); const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
          const scene = new THREE.Scene(); scene.environment = env;
          scene.add(new THREE.AmbientLight("#8a78ff", 0.8));
          const kl = new THREE.DirectionalLight("#ffffff", 1.6); kl.position.set(2.2, 3, 2.4); scene.add(kl);
          const rim = new THREE.DirectionalLight(tierColor, 2.2); rim.position.set(-2.4, 1.2, -2.2); scene.add(rim);
          const model = gltf.scene; frameModel(model, yaw); model.rotation.y += -0.5; scene.add(model);
          r.render(scene, makeCam());
          img.src = r.domElement.toDataURL("image/png");
          disposeModel(model); env.dispose(); r.dispose();
        }, undefined, (err) => console.warn("[reveal-car] GLB failed:", url, err));
      },
      clear() { img.removeAttribute("src"); loadGen++; },
      dispose() {},
    };
  }

  // ---- high tier: lazily-created persistent spinning canvas ----
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene, cam: THREE.PerspectiveCamera, pivot: THREE.Group, rim: THREE.DirectionalLight, env: THREE.Texture;
  let raf = 0, last = 0, current: THREE.Object3D | null = null;

  const ensure = () => {
    if (renderer) return;
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(pr()); renderer.setSize(SIZE, SIZE, false);
    renderer.domElement.style.cssText = `width:${SIZE}px;height:${SIZE}px`;
    el.appendChild(renderer.domElement);
    const pmrem = new THREE.PMREMGenerator(renderer); env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
    cam = makeCam();
    scene = new THREE.Scene(); scene.environment = env;
    scene.add(new THREE.AmbientLight("#8a78ff", 0.8));
    const kl = new THREE.DirectionalLight("#ffffff", 1.6); kl.position.set(2.2, 3, 2.4); scene.add(kl);
    rim = new THREE.DirectionalLight("#ffffff", 2.2); rim.position.set(-2.4, 1.2, -2.2); scene.add(rim);
    pivot = new THREE.Group(); scene.add(pivot);
  };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  const drop = () => { if (current) { pivot.remove(current); disposeModel(current); current = null; } };
  const loop = (t: number) => {
    raf = requestAnimationFrame(loop);
    const dt = last ? (t - last) / 1000 : 0; last = t;
    pivot.rotation.y += dt * 0.7;
    renderer!.render(scene, cam);
  };

  return {
    el,
    show({ url, yaw = 0, tierColor }) {
      ensure();
      rim.color.set(tierColor);
      const gen = ++loadGen;
      loader.load(url, (gltf) => {
        if (gen !== loadGen) return;
        drop();
        const model = gltf.scene; frameModel(model, yaw); pivot.add(model); current = model;
        pivot.rotation.y = -0.5; last = 0; stop(); raf = requestAnimationFrame(loop);
      }, undefined, (err) => console.warn("[reveal-car] GLB failed:", url, err));
    },
    clear() { stop(); if (renderer) drop(); loadGen++; },
    dispose() { stop(); if (renderer) { drop(); env.dispose(); renderer.dispose(); renderer = null; } },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd redline3d && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add redline3d/src/ui/reveal-car.ts
git commit -m "feat(reveal): 3D car viewer — live spin (high tier) / static PNG (low tier)"
```

---

### Task 4: Reskin the reveal in `cratebox.ts`

**Files:**
- Modify: `src/ui/cratebox.ts` (imports, `CrateBoxDeps`, `injectStyles`, `showReveal`, `doOpen`, `showShop`, `close`, `setBusy`, `createCrateBox` body)
- Modify: `src/ui/cratebox.test.ts` (`stubDeps`)

- [ ] **Step 1: Imports + deps interface**

At the top imports, add:
```ts
import { createRevealCar } from "./reveal-car";
import { scrapPileHtml, levelPosterHtml, type LevelPoster } from "./reveal-bits";
```
In `CrateBoxDeps`, change the `levelInfo` line and add `lowTier`:
```ts
  levelInfo: (key: string) => LevelPoster;   // theme palette for the reward poster
  lowTier: boolean;                          // weak-GPU tier → static car image instead of a live canvas
```

- [ ] **Step 2: Add reveal CSS**

Inside `injectStyles`, append these rules to the `s.textContent` template (keep the existing rules):
```css
    .cb-hero{width:220px;height:220px;display:flex;align-items:center;justify-content:center;animation:cbCardIn .5s cubic-bezier(.22,1.2,.36,1) both}
    .cb-plate{display:flex;flex-direction:column;align-items:center;gap:6px}
    .cb-halo.big{width:300px;height:300px;top:-14px}
    .cb-loot{align-items:flex-end}
    .cb-scrap{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:96px;padding:10px 12px;border-radius:12px;background:rgba(18,14,40,.7);border:1px solid rgba(132,150,224,.28)}
    .cb-scrap-heap{position:relative;width:80px;height:34px}
    .cb-shard{position:absolute;background:var(--sc);border-radius:2px;box-shadow:0 0 4px rgba(154,164,178,.4)}
    .cb-scrap-n{font:800 16px/1 'Chakra Petch',ui-monospace,monospace;color:#e6ecf7}
    .cb-scrap-lbl{font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.14em;color:#9aa4b2}
    .cb-poster{width:120px;border-radius:12px;overflow:hidden;border:1px solid rgba(132,150,224,.4);animation:cbCardIn .5s cubic-bezier(.22,1.2,.36,1) .12s both}
    .cb-poster-sky{position:relative;height:60px}
    .cb-poster-disc{position:absolute;top:9px;left:50%;transform:translateX(-50%);width:24px;height:24px;border-radius:50%;box-shadow:0 0 12px currentColor}
    .cb-poster-grid{position:absolute;left:6px;right:6px;bottom:9px;height:1.5px;opacity:.9}
    .cb-poster-grid.low{bottom:4px;opacity:.55}
    .cb-poster-body{padding:7px 6px;text-align:center;background:rgba(10,7,22,.96)}
    .cb-poster-nm{font:800 13px/1.1 'Chakra Petch',ui-monospace,monospace;color:#fff}
    .cb-poster-tag{margin-top:3px;font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.12em;color:#7fbfff}
```

- [ ] **Step 3: Instantiate the viewer**

In `createCrateBox`, after `const q = ...; const coinsEl = ...` (where the other elements are grabbed), add:
```ts
  const revealCar = createRevealCar({ lowTier: deps.lowTier });
```

- [ ] **Step 4: Rewrite `showReveal`**

Replace the whole `showReveal` function with:
```ts
  const showReveal = (crate: CrateType, car: CrateCar, isNew: boolean, scrap: number, lvlKey: string | null) => {
    opening = false;
    const t = tierOf(car.rarity);
    const lvl = lvlKey ? deps.levelInfo(lvlKey) : null;
    const bigBurst = t.id >= 4; // epic/legendary get a larger halo
    stage.innerHTML =
      `<div class="cb-halo${bigBurst ? " big" : ""}" style="--tc:${t.color}"></div>` +
      `<div class="cb-hero" data-cb="carslot"></div>` +
      `<div class="cb-plate">` +
        `<span class="cb-badge ${isNew ? "new" : "dupe"}">${isNew ? "NEW" : "DUPLICATE"}</span>` +
        `<div class="cb-tier" style="--tc:${t.color}">${t.name}</div>` +
        `<div class="cb-gems">${gems(t.id)}</div>` +
        `<div class="cb-name" style="--tc:${t.color}">${car.name}</div>` +
      `</div>` +
      `<div class="cb-loot">` +
        scrapPileHtml(scrap) +
        (lvl ? levelPosterHtml(lvl) : "") +
      `</div>`;
    stage.classList.add("on");
    const slot = stage.querySelector('[data-cb="carslot"]') as HTMLElement;
    slot.appendChild(revealCar.el);
    revealCar.show({ url: car.url ?? "", scale: car.scale, yaw: car.yaw, tierColor: t.color });
    const again = deps.coins() >= crate.priceCoins;
    btns.style.display = "flex";
    btns.innerHTML =
      `<button class="cb-btn ghost" data-cb="done">Done</button>` +
      (again ? `<button class="cb-btn" data-open="${crate.key}">${crate.name.split(" ")[0]} again · ${crate.priceCoins} ◈</button>` : "");
  };
```
Note: `cb-tier`/`cb-name` now take an inline `--tc` (the existing CSS reads `var(--tc)`); the old `.cb-card` wrapper is gone.

- [ ] **Step 5: Clear the viewer when leaving the reveal**

In `showShop`, after `stage.classList.remove("on"); stage.innerHTML = "";` add:
```ts
    revealCar.clear();
```
In `close()`, after `overlay.style.display = "none";` add:
```ts
    revealCar.clear();
```
In `setBusy`, change the body to also stop the spin when hiding:
```ts
    setBusy(b) { if (b && !opening) { overlay.style.display = "none"; revealCar.clear(); } },
```

- [ ] **Step 6: Bigger burst on the opening crate for rare tiers (choreography)**

In `doOpen`, the roll result is known before the animation (`car`, `crate`). After `const flash = stage.querySelector(".cb-flash") as HTMLElement;`, scale the flash for a rare pull:
```ts
    if (tierOf(car.rarity).id >= 4) flash.style.transform = "scale(1.5)";
```
(Leave the existing shake→gone→flash→`showReveal` timing as-is.)

- [ ] **Step 7: Update the test stub**

In `src/ui/cratebox.test.ts`, replace the `levelInfo` line in `stubDeps` and add `lowTier`:
```ts
  levelInfo: () => ({ name: "", sky: ["#000", "#000"], disc: "#000", grid: ["#000", "#000"] }),
  lowTier: false,
```

- [ ] **Step 8: Run the crate tests + typecheck**

Run: `cd redline3d && npx vitest run src/ui/cratebox.test.ts src/ui/reveal-bits.test.ts && npx tsc --noEmit`
Expected: PASS — odds tests unaffected; reveal-bits green; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add redline3d/src/ui/cratebox.ts redline3d/src/ui/cratebox.test.ts
git commit -m "feat(reveal): Hearthstone-style reveal — spinning car hero + scrap pile + level poster"
```

---

### Task 5: Wire the tier + richer level palette in `main.ts`

**Files:**
- Modify: `src/main.ts:504-516` (the `createCrateBox` deps)

- [ ] **Step 1: Edit the deps**

Change the `levelInfo` line and add `lowTier` inside the `createCrateBox(hudRoot, { ... })` object:
```ts
  levelInfo: (key) => { const t = themeOf(key); return { name: t.name, sky: [t.sky[0], t.sky[1]], disc: t.celestialColors[0], grid: [t.grid[0], t.grid[1]] }; },
  lowTier: quality.tier === "low",
```
(`themeOf`, `THEMES`, and `quality` are already in scope above this call.)

- [ ] **Step 2: Typecheck**

Run: `cd redline3d && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add redline3d/src/main.ts
git commit -m "feat(reveal): pass perf tier + theme-palette levelInfo into the crate box"
```

---

### Task 6: Full verification (worker)

- [ ] **Step 1: Full test suite**

Run: `cd redline3d && npx vitest run`
Expected: all pass (prior green count + the new `reveal-bits` file; no regressions).

- [ ] **Step 2: Typecheck**

Run: `cd redline3d && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Report** the diff summary + both command results verbatim. Do NOT attempt browser verification — the main session does that in Claude Preview (forcing a legendary+level via an injected `deps.rng`, checking a duplicate, and `?perf=low` for the static-car path).

---

## Self-Review

**Spec coverage:**
- Car → spinning 3D hero, live/high + static/low → Task 3 + Task 4 Step 4. ✓
- Scrap → little pile → Task 2 (`scrapPileHtml`) + Task 4 Steps 2/4. ✓
- Level → poster card → Task 2 (`levelPosterHtml`) + Task 5 (palette) + Task 4. ✓
- All on one screen + staged burst → Task 4 (`showReveal` layout, `.cb-loot`, halo, doOpen flash). ✓
- Tier fallback → Task 3 (lowTier branch) + Task 5 (`lowTier` from `quality.tier`). ✓
- Roll logic untouched → only `crate.ts` type widened (Task 1); `rollCrate`/`dupeScrap`/`pickLevel` unchanged. ✓
- Testing: pure helpers TDD (Task 2), existing odds test kept green (Task 4 Step 7-8), browser by main session. ✓

**Type consistency:** `LevelPoster` defined in `reveal-bits.ts` (Task 2), consumed by `CrateBoxDeps.levelInfo` (Task 4 Step 1), produced by `main.ts` (Task 5) and the test stub (Task 4 Step 7) — all four use `{ name, sky:[a,b], disc, grid:[a,b] }`. `createRevealCar`/`RevealCar` signature identical in Task 3 and its use in Task 4 Steps 3-5. `car.url/scale/yaw` widened in Task 1, read in Task 4 Step 4.

**Placeholder scan:** no TBD/TODO; every code step shows complete code.
