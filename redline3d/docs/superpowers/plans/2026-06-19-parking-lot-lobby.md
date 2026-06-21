# Parking-Lot Lobby Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a map button that drops the player into a giant drivable neon parking lot containing three market buildings (SOL/BTC/ETH); driving into a building selects that market and returns to the race.

**Architecture:** A new app mode `"race" | "lobby"` in `main.ts`. The lobby reuses the single renderer/scene/camera/car. Two pure, TDD'd cores carry the logic: `core/freedrive.ts` (arcade car kinematics) and `core/lobby-layout.ts` (building + entrance geometry). Render modules (`render/lobby.ts`, `render/lobbycam.ts`) and thin UI (`ui/mapbutton.ts`, `ui/lobbyhud.ts`) are wired in `main.ts`. A `remoteCars` group stays empty today as the multiplayer seam.

**Tech Stack:** TypeScript (strict), Three.js 0.169, Vite 5, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-19-garage-lobby-design.md`

**Conventions:** Run all commands from `redline3d/`. Tests: `npx vitest run <file>`. Typecheck: `npx tsc --noEmit 2>&1 | grep -v "nitro?v=2"` (the `./ui/nitro?v=2` cache-buster import is a known Vite-only artifact and the only allowed tsc error). Commit messages end with the project's Co-Authored-By trailer.

---

### Task 1: `core/freedrive.ts` — arcade free-roam kinematics (pure, TDD)

**Files:**
- Create: `src/core/freedrive.ts`
- Test: `src/core/freedrive.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { step, type DriveState } from "./freedrive";

const BOUNDS = { x: 60, z: 60 };
const spawn = (): DriveState => ({ x: 0, z: 0, heading: 0, speed: 0 });

describe("freedrive.step", () => {
  it("accelerates forward (-Z) under full gas", () => {
    let s = spawn();
    for (let i = 0; i < 30; i++) s = step(s, { throttle: 1, steer: 0 }, 1 / 60, BOUNDS);
    expect(s.speed).toBeGreaterThan(0);
    expect(s.z).toBeLessThan(0); // heading 0 drives toward -Z
    expect(Math.abs(s.x)).toBeLessThan(1e-6);
  });

  it("coasts to a stop when throttle is released", () => {
    let s = { ...spawn(), speed: 20 };
    for (let i = 0; i < 600; i++) s = step(s, { throttle: 0, steer: 0 }, 1 / 60, BOUNDS);
    expect(Math.abs(s.speed)).toBeLessThan(0.5);
  });

  it("reverses under negative throttle", () => {
    let s = spawn();
    for (let i = 0; i < 30; i++) s = step(s, { throttle: -1, steer: 0 }, 1 / 60, BOUNDS);
    expect(s.speed).toBeLessThan(0);
    expect(s.z).toBeGreaterThan(0); // backing up moves toward +Z
  });

  it("does not turn while parked", () => {
    const s = step(spawn(), { throttle: 0, steer: 1 }, 1 / 60, BOUNDS);
    expect(s.heading).toBe(0);
  });

  it("turns while moving", () => {
    let s = { ...spawn(), speed: 20 };
    s = step(s, { throttle: 1, steer: 1 }, 1 / 60, BOUNDS);
    expect(s.heading).not.toBe(0);
  });

  it("clamps speed to the max", () => {
    let s = spawn();
    for (let i = 0; i < 600; i++) s = step(s, { throttle: 1, steer: 0 }, 1 / 60, BOUNDS);
    expect(s.speed).toBeLessThanOrEqual(34 + 1e-6);
  });

  it("stops at the lot wall and cannot escape bounds", () => {
    let s = { ...spawn(), z: -59, speed: 34 };
    for (let i = 0; i < 120; i++) s = step(s, { throttle: 1, steer: 0 }, 1 / 60, BOUNDS);
    expect(s.z).toBeGreaterThanOrEqual(-60 - 1e-6);
    expect(s.z).toBeCloseTo(-60, 5);
    expect(s.speed).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/freedrive.test.ts`
Expected: FAIL — `Failed to resolve import "./freedrive"` / `step is not a function`.

- [ ] **Step 3: Write the implementation**

```ts
export interface DriveState { x: number; z: number; heading: number; speed: number }
export interface DriveInput { throttle: number; steer: number }
export interface Bounds { x: number; z: number }

// arcade tuning — units/sec
export const DRIVE = { ACCEL: 26, MAX_FWD: 34, MAX_REV: 12, DRAG: 1.8, TURN: 1.9, TURN_REF: 8 };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * One arcade-driving step. heading 0 faces -Z (the game's forward). Gas/reverse via
 * throttle (-1..1); steering turn-rate scales with speed and reverses when backing up;
 * coasting bleeds speed toward 0; position is clamped to the lot, killing into-wall speed.
 */
export function step(s: DriveState, input: DriveInput, dt: number, bounds: Bounds): DriveState {
  const th = clamp(input.throttle, -1, 1);
  const st = clamp(input.steer, -1, 1);

  let speed = s.speed;
  if (Math.abs(th) > 0.05) speed += th * DRIVE.ACCEL * dt;
  else speed -= speed * Math.min(1, DRIVE.DRAG * dt); // coast toward 0
  speed = clamp(speed, -DRIVE.MAX_REV, DRIVE.MAX_FWD);

  // turn only while moving; effect grows with speed and flips in reverse
  const turnScale = clamp(Math.abs(speed) / DRIVE.TURN_REF, 0, 1) * Math.sign(speed || 1);
  const heading = s.heading + st * DRIVE.TURN * turnScale * dt;

  let x = s.x + Math.sin(heading) * speed * dt;
  let z = s.z - Math.cos(heading) * speed * dt;

  if (x > bounds.x) { x = bounds.x; speed = 0; }
  else if (x < -bounds.x) { x = -bounds.x; speed = 0; }
  if (z > bounds.z) { z = bounds.z; speed = 0; }
  else if (z < -bounds.z) { z = -bounds.z; speed = 0; }

  return { x, z, heading, speed };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/freedrive.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/freedrive.ts src/core/freedrive.test.ts
git commit -m "feat(lobby): arcade free-roam kinematics core"
```

---

### Task 2: `core/lobby-layout.ts` — building + entrance geometry (pure, TDD)

**Files:**
- Create: `src/core/lobby-layout.ts`
- Test: `src/core/lobby-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { BUILDINGS, DOORS, LOT_BOUNDS, entranceHit } from "./lobby-layout";

describe("lobby-layout", () => {
  it("has one building + one door per market", () => {
    expect(BUILDINGS.map((b) => b.asset).sort()).toEqual(["BTC", "ETH", "SOL"]);
    expect(DOORS.map((d) => d.asset).sort()).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("keeps every building inside the lot bounds", () => {
    for (const b of BUILDINGS) {
      expect(Math.abs(b.x) + b.w / 2).toBeLessThanOrEqual(LOT_BOUNDS.x);
      expect(Math.abs(b.z) + b.d / 2).toBeLessThanOrEqual(LOT_BOUNDS.z);
    }
  });

  it("returns the matching asset at a doorway centre", () => {
    for (const d of DOORS) expect(entranceHit(d.x, d.z)).toBe(d.asset);
  });

  it("returns null far from every door", () => {
    expect(entranceHit(0, LOT_BOUNDS.z)).toBeNull();
  });

  it("has non-overlapping doors", () => {
    for (let i = 0; i < DOORS.length; i++)
      for (let j = i + 1; j < DOORS.length; j++) {
        const a = DOORS[i], b = DOORS[j];
        const dist = Math.hypot(a.x - b.x, a.z - b.z);
        expect(dist).toBeGreaterThan(a.r + b.r);
      }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/core/lobby-layout.test.ts`
Expected: FAIL — cannot resolve `./lobby-layout`.

- [ ] **Step 3: Write the implementation**

```ts
export type Asset = "SOL" | "BTC" | "ETH";

export interface Building { asset: Asset; x: number; z: number; w: number; d: number; color: number; name: string }
export interface DoorZone { asset: Asset; x: number; z: number; r: number }

// the drivable lot: half-extents in world units (120 x 120)
export const LOT_BOUNDS = { x: 60, z: 60 };

// three buildings along the far (-Z) end of the lot
export const BUILDINGS: Building[] = [
  { asset: "BTC", x: -34, z: -42, w: 20, d: 14, color: 0xf7931a, name: "BITCOIN" },
  { asset: "ETH", x: 0, z: -48, w: 18, d: 14, color: 0x7c8cff, name: "ETHEREUM" },
  { asset: "SOL", x: 34, z: -42, w: 20, d: 14, color: 0x14f195, name: "SOLANA" },
];

// entrance trigger: a circle just in front (+Z side) of each building's door
export const DOORS: DoorZone[] = BUILDINGS.map((b) => ({ asset: b.asset, x: b.x, z: b.z + b.d / 2 + 5, r: 6 }));

/** which doorway the point (x,z) is inside, or null */
export function entranceHit(x: number, z: number): Asset | null {
  for (const d of DOORS) {
    const dx = x - d.x, dz = z - d.z;
    if (dx * dx + dz * dz <= d.r * d.r) return d.asset;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/core/lobby-layout.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/lobby-layout.ts src/core/lobby-layout.test.ts
git commit -m "feat(lobby): parking-lot layout + entrance geometry core"
```

---

### Task 3: `render/lobbycam.ts` — yaw-aware follow camera

**Files:**
- Create: `src/render/lobbycam.ts`

No unit test (camera math is verified manually in preview, matching the repo's untested `camera.ts`/`scene.ts` convention).

- [ ] **Step 1: Write the implementation**

```ts
import * as THREE from "three";

export interface LobbyCam {
  /** follow the free-roam car: behind + above along its heading, looking ahead */
  update(camera: THREE.PerspectiveCamera, dt: number, x: number, z: number, heading: number): void;
  /** snap the rig to the car instantly (call on entering the lobby) */
  reset(): void;
}

const BACK = 17, HEIGHT = 8.5, LOOK_AHEAD = 12, LOOK_Y = 1.6, FOV = 64;

export function createLobbyCam(): LobbyCam {
  const camPos = new THREE.Vector3();
  const lookPos = new THREE.Vector3();
  let inited = false;

  return {
    reset() { inited = false; },
    update(camera, dt, x, z, heading) {
      const fx = Math.sin(heading), fz = -Math.cos(heading); // forward vector
      const tx = x - fx * BACK, tz = z - fz * BACK;          // camera target: behind the car
      const lx = x + fx * LOOK_AHEAD, lz = z + fz * LOOK_AHEAD; // look target: ahead of the car
      if (!inited) { camPos.set(tx, HEIGHT, tz); lookPos.set(lx, LOOK_Y, lz); inited = true; }
      const k = Math.min(1, dt * 4);
      camPos.x += (tx - camPos.x) * k; camPos.y += (HEIGHT - camPos.y) * k; camPos.z += (tz - camPos.z) * k;
      lookPos.x += (lx - lookPos.x) * k; lookPos.y += (LOOK_Y - lookPos.y) * k; lookPos.z += (lz - lookPos.z) * k;
      if (camera.fov !== FOV) { camera.fov = FOV; camera.updateProjectionMatrix(); }
      camera.position.copy(camPos);
      camera.lookAt(lookPos);
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v "nitro?v=2"`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add src/render/lobbycam.ts
git commit -m "feat(lobby): yaw-aware follow camera"
```

---

### Task 4: `render/lobby.ts` — parking-lot scene + buildings + multiplayer seam

**Files:**
- Create: `src/render/lobby.ts`

No unit test (Three.js scene graph; verified in preview).

- [ ] **Step 1: Write the implementation**

```ts
import * as THREE from "three";
import { BUILDINGS, LOT_BOUNDS } from "../core/lobby-layout";

export interface RemoteCarState { id: string; x: number; z: number; heading: number }

export interface Lobby {
  group: THREE.Group;
  show(): void;
  hide(): void;
  /** multiplayer seam — called with [] today; later a presence feed drives ghost cars */
  setRemoteCars(states: RemoteCarState[]): void;
  update(dt: number): void;
  dispose(): void;
}

function signTexture(name: string, css: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.font = "700 84px 'Chakra Petch', ui-monospace, monospace";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = css; g.shadowBlur = 28;
  g.fillStyle = css;
  g.fillText(name, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

export function createLobby(): Lobby {
  const group = new THREE.Group();
  group.visible = false;
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  // floor
  const floorGeo = track(new THREE.PlaneGeometry(LOT_BOUNDS.x * 2, LOT_BOUNDS.z * 2));
  const floorMat = track(new THREE.MeshStandardMaterial({ color: 0x0a0820, metalness: 0.55, roughness: 0.45 }));
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  // neon grid over the floor
  const grid = new THREE.GridHelper(Math.max(LOT_BOUNDS.x, LOT_BOUNDS.z) * 2, 30, 0xff4dd2, 0x6a2bd9);
  const gm = grid.material as THREE.Material;
  gm.transparent = true; (gm as THREE.Material & { opacity: number }).opacity = 0.32;
  grid.position.y = 0.02;
  group.add(grid);

  // glowing perimeter walls
  const wallMat = track(new THREE.MeshStandardMaterial({ color: 0x180a30, emissive: 0xff4dd2, emissiveIntensity: 0.55 }));
  const wallGeoLR = track(new THREE.BoxGeometry(1, 2.4, LOT_BOUNDS.z * 2));
  const wallGeoFB = track(new THREE.BoxGeometry(LOT_BOUNDS.x * 2, 2.4, 1));
  const addWall = (geo: THREE.BoxGeometry, x: number, z: number) => {
    const m = new THREE.Mesh(geo, wallMat); m.position.set(x, 1.2, z); group.add(m);
  };
  addWall(wallGeoLR, -LOT_BOUNDS.x, 0); addWall(wallGeoLR, LOT_BOUNDS.x, 0);
  addWall(wallGeoFB, 0, -LOT_BOUNDS.z); addWall(wallGeoFB, 0, LOT_BOUNDS.z);

  // buildings
  for (const b of BUILDINGS) {
    const bg = new THREE.Group(); bg.position.set(b.x, 0, b.z);
    const hex = "#" + b.color.toString(16).padStart(6, "0");

    const bodyGeo = track(new THREE.BoxGeometry(b.w, 18, b.d));
    const bodyMat = track(new THREE.MeshStandardMaterial({ color: 0x120a28, emissive: b.color, emissiveIntensity: 0.16, metalness: 0.4, roughness: 0.55 }));
    const body = new THREE.Mesh(bodyGeo, bodyMat); body.position.y = 9; bg.add(body);

    const doorGeo = track(new THREE.BoxGeometry(b.w * 0.3, 6, 0.5));
    const doorMat = track(new THREE.MeshStandardMaterial({ color: b.color, emissive: b.color, emissiveIntensity: 1.5 }));
    const door = new THREE.Mesh(doorGeo, doorMat); door.position.set(0, 3, b.d / 2 + 0.2); bg.add(door);

    const signGeo = track(new THREE.PlaneGeometry(b.w * 0.92, b.w * 0.92 / 4));
    const signMat = track(new THREE.MeshBasicMaterial({ map: track(signTexture(b.name, hex)), transparent: true, depthWrite: false }));
    const sign = new THREE.Mesh(signGeo, signMat); sign.position.set(0, 19.5, b.d / 2 + 0.1); bg.add(sign);

    const lamp = new THREE.PointLight(b.color, 7, 34, 2); lamp.position.set(0, 5, b.d / 2 + 4); bg.add(lamp);
    group.add(bg);
  }

  // ambient fill so the lot isn't pitch black
  const amb = new THREE.AmbientLight(0x6a4cff, 0.5); group.add(amb);

  // remote cars — multiplayer seam (empty today)
  const remoteGroup = new THREE.Group(); group.add(remoteGroup);
  const remoteMap = new Map<string, THREE.Mesh>();
  const remoteGeo = track(new THREE.BoxGeometry(3.6, 1.6, 7));
  const remoteMat = track(new THREE.MeshStandardMaterial({ color: 0x223, emissive: 0x4da6ff, emissiveIntensity: 0.4 }));

  let t = 0;
  return {
    group,
    show() { group.visible = true; },
    hide() { group.visible = false; },
    setRemoteCars(states) {
      const seen = new Set<string>();
      for (const s of states) {
        seen.add(s.id);
        let m = remoteMap.get(s.id);
        if (!m) { m = new THREE.Mesh(remoteGeo, remoteMat); remoteGroup.add(m); remoteMap.set(s.id, m); }
        m.position.set(s.x, 0.9, s.z); m.rotation.y = s.heading;
      }
      for (const [id, m] of remoteMap) if (!seen.has(id)) { remoteGroup.remove(m); remoteMap.delete(id); }
    },
    update(dt) { t += dt; },
    dispose() {
      for (const d of disposables) d.dispose();
      remoteMap.clear();
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v "nitro?v=2"`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add src/render/lobby.ts
git commit -m "feat(lobby): drivable parking-lot scene with 3 market buildings"
```

---

### Task 5: `ui/mapbutton.ts` — map icon button (enter the lobby)

**Files:**
- Create: `src/ui/mapbutton.ts`
- Test: `src/ui/mapbutton.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createMapButton } from "./mapbutton";

describe("createMapButton", () => {
  it("fires onClick and toggles visibility", () => {
    const parent = document.createElement("div");
    const onClick = vi.fn();
    const mb = createMapButton(parent, onClick);
    const btn = parent.querySelector("button")!;
    expect(btn).toBeTruthy();
    btn.dispatchEvent(new Event("click"));
    expect(onClick).toHaveBeenCalledOnce();
    mb.setVisible(false);
    expect(btn.style.display).toBe("none");
    mb.setVisible(true);
    expect(btn.style.display).toBe("grid");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/mapbutton.test.ts`
Expected: FAIL — cannot resolve `./mapbutton`.

- [ ] **Step 3: Write the implementation**

```ts
export interface MapButton {
  el: HTMLButtonElement;
  setVisible(visible: boolean): void;
}

// map-pin glyph, neon line style consistent with the carpicker icons
const MAP_SVG =
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>`;

/** A map-pin button left of the radio toggle; opens the parking-lot lobby. */
export function createMapButton(parent: HTMLElement, onClick: () => void): MapButton {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pe panel";
  btn.setAttribute("aria-label", "Open garage lobby");
  btn.innerHTML = MAP_SVG;
  btn.style.cssText = [
    "position:absolute",
    "top:144px", // same row as the radio, one slot to its left
    "right:max(112px,calc(env(safe-area-inset-right) + 100px))",
    "z-index:8",
    "width:42px", "height:42px", "padding:0",
    "display:grid", "place-items:center",
    "border-radius:9px", "cursor:pointer",
    "background:rgba(12,10,26,.74)",
    "color:var(--cyan)",
  ].join(";");
  btn.onclick = onClick;
  parent.appendChild(btn);

  return {
    el: btn,
    setVisible(visible) { btn.style.display = visible ? "grid" : "none"; },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/mapbutton.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/mapbutton.ts src/ui/mapbutton.test.ts
git commit -m "feat(lobby): map-pin button to open the lobby"
```

---

### Task 6: `ui/lobbyhud.ts` — exit control + "ENTER {MARKET}" prompt

**Files:**
- Create: `src/ui/lobbyhud.ts`
- Test: `src/ui/lobbyhud.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createLobbyHud } from "./lobbyhud";

describe("createLobbyHud", () => {
  it("hides by default, shows on show(), and fires onExit", () => {
    const parent = document.createElement("div");
    const onExit = vi.fn();
    const hud = createLobbyHud(parent, onExit);
    expect(hud.el.style.display).toBe("none");
    hud.show();
    expect(hud.el.style.display).toBe("block");
    hud.el.querySelector<HTMLButtonElement>("[data-exit]")!.dispatchEvent(new Event("click"));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("shows the prompt for an asset and clears it on null", () => {
    const parent = document.createElement("div");
    const hud = createLobbyHud(parent, () => {});
    hud.setPrompt("SOL");
    const prompt = hud.el.querySelector<HTMLElement>("[data-prompt]")!;
    expect(prompt.style.opacity).toBe("1");
    expect(prompt.textContent).toContain("SOLANA");
    hud.setPrompt(null);
    expect(prompt.style.opacity).toBe("0");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/lobbyhud.test.ts`
Expected: FAIL — cannot resolve `./lobbyhud`.

- [ ] **Step 3: Write the implementation**

```ts
import type { Asset } from "../core/lobby-layout";

export interface LobbyHud {
  el: HTMLElement;
  show(): void;
  hide(): void;
  /** show "ENTER {NAME}" while in a doorway, or null to clear */
  setPrompt(asset: Asset | null): void;
}

const NAMES: Record<Asset, string> = { SOL: "SOLANA", BTC: "BITCOIN", ETH: "ETHEREUM" };

const BACK_SVG =
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>`;

/** Minimal lobby overlay: a back/exit button + a centred "ENTER {MARKET}" prompt. */
export function createLobbyHud(parent: HTMLElement, onExit: () => void): LobbyHud {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;inset:0;z-index:9;pointer-events:none;display:none";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "pe panel";
  back.dataset.exit = "1";
  back.setAttribute("aria-label", "Leave the lobby");
  back.innerHTML = BACK_SVG;
  back.style.cssText = [
    "position:absolute", "top:max(10px,env(safe-area-inset-top))", "left:14px",
    "width:42px", "height:42px", "padding:0", "display:grid", "place-items:center",
    "border-radius:9px", "cursor:pointer", "background:rgba(12,10,26,.74)", "color:var(--cyan)",
  ].join(";");
  back.onclick = onExit;
  el.appendChild(back);

  const hint = document.createElement("div");
  hint.className = "lbl";
  hint.textContent = "hold to drive · drag to steer · reach a building to enter";
  hint.style.cssText = "position:absolute;left:0;right:0;top:64px;text-align:center;color:#b7a9ee;letter-spacing:.06em;text-shadow:0 1px 8px rgba(0,0,0,.8)";
  el.appendChild(hint);

  const prompt = document.createElement("div");
  prompt.dataset.prompt = "1";
  prompt.className = "num";
  prompt.style.cssText = [
    "position:absolute", "left:50%", "bottom:120px", "transform:translateX(-50%)",
    "padding:10px 20px", "border-radius:11px", "font-size:18px", "letter-spacing:.08em",
    "background:rgba(11,8,32,.86)", "border:1px solid var(--cyan)", "color:var(--cyan)",
    "opacity:0", "transition:opacity .18s ease",
  ].join(";");
  el.appendChild(prompt);

  parent.appendChild(el);

  return {
    el,
    show() { el.style.display = "block"; },
    hide() { el.style.display = "none"; },
    setPrompt(asset) {
      if (asset) {
        prompt.textContent = "ENTER " + NAMES[asset];
        prompt.style.opacity = "1";
      } else {
        prompt.style.opacity = "0";
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/lobbyhud.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/lobbyhud.ts src/ui/lobbyhud.test.ts
git commit -m "feat(lobby): exit button + ENTER-market prompt hud"
```

---

### Task 7: `main.ts` — mode, input routing, frame branch, transitions

**Files:**
- Modify: `src/main.ts`

This wires everything together. Apply the edits in order.

- [ ] **Step 1: Add imports**

After the existing `import { createRadio } from "./ui/radio";` block (near line 25-27), add:

```ts
import { createLobby } from "./render/lobby";
import { createLobbyCam } from "./render/lobbycam";
import { createMapButton } from "./ui/mapbutton";
import { createLobbyHud } from "./ui/lobbyhud";
import { step as driveStep, type DriveState } from "./core/freedrive";
import { entranceHit, LOT_BOUNDS, type Asset } from "./core/lobby-layout";
```

- [ ] **Step 2: Create the lobby scene, camera, and UI**

Immediately after `const radio = createRadio(hudRoot);` (line 109), add:

```ts
// ── parking-lot lobby ──────────────────────────────────────────────────────
const lobby = createLobby();
ctx.scene.add(lobby.group);
const lobbyCam = createLobbyCam();
let mode: "race" | "lobby" = "race";
let drive: DriveState = { x: 0, z: LOT_BOUNDS.z - 8, heading: 0, speed: 0 };
let doorDwell = 0;
let steerNorm = 0; // current steering from the pointer drag (-1..1), shared with the lobby

const radioBtn = hudRoot.querySelector('[aria-label="Toggle music"]') as HTMLElement | null;
const hudPrev = new Map<HTMLElement, string>();
function setRaceHudVisible(visible: boolean) {
  for (const child of Array.from(hudRoot.children) as HTMLElement[]) {
    if (child === mapBtn.el || child === lobbyHud.el || child === radioBtn) continue;
    if (!visible) { hudPrev.set(child, child.style.display); child.style.display = "none"; }
    else { const d = hudPrev.get(child); if (d !== undefined) child.style.display = d; }
  }
  if (visible) hudPrev.clear();
}

function enterLobby() {
  if (engine.getPhase() === "live") return;
  mode = "lobby";
  drive = { x: 0, z: LOT_BOUNDS.z - 8, heading: 0, speed: 0 };
  doorDwell = 0;
  lobbyCam.reset();
  world.group.visible = false;
  pickups.group.visible = false;
  lobby.show();
  setRaceHudVisible(false);
  mapBtn.setVisible(false);
  lobbyHud.show();
  audio.resume(); radio.resume();
}

function exitLobby(selected?: Asset) {
  mode = "race";
  lobby.hide();
  lobbyHud.hide();
  lobbyHud.setPrompt(null);
  world.group.visible = true;
  pickups.group.visible = true;
  setRaceHudVisible(true);
  mapBtn.setVisible(true);
  // restore the road car pose; the chase cam takes back over next frame
  car.group.position.set(0, 0, -12);
  car.group.rotation.set(0, 0, 0);
  if (selected) {
    asset = selected;
    solSmooth = 0; solEMA = 0; priceHist.length = 0;
    hud.setActiveAsset(selected);
  }
}

const mapBtn = createMapButton(hudRoot, () => { if (mode === "race") enterLobby(); });
const lobbyHud = createLobbyHud(hudRoot, () => exitLobby());
```

Note: `mapBtn` / `lobbyHud` are referenced inside `setRaceHudVisible`/`enterLobby` before their `const` lines, but those functions only run later (on click / per frame), after initialisation — this is the same forward-reference pattern already used elsewhere in `main.ts`. Keep the two `create…` lines at the end of this block.

- [ ] **Step 3: Let the pointer handlers drive in the lobby too**

In the `canvas.addEventListener("pointerdown", …)` handler (line 141), change the showroom gate so the lobby is drivable. Replace:

```ts
  if (engine.getPhase() !== "live") return; // showroom: no driving until the round is live
```

with:

```ts
  if (mode !== "lobby" && engine.getPhase() !== "live") return; // showroom: no driving until live (lobby is always drivable)
```

In the `addEventListener("pointermove", …)` handler (line 151-160), after the line that sets `carXTarget` from the drag, add a normalized steer value the lobby reads:

```ts
  steerNorm = Math.max(-1, Math.min(1, dx / (innerWidth * 0.32)));
```

In `releaseHold` (line 148), reset it. Replace:

```ts
const releaseHold = () => { holding = false; touchGas = false; touchBrake = false; joystick.hide(); };
```

with:

```ts
const releaseHold = () => { holding = false; touchGas = false; touchBrake = false; steerNorm = 0; joystick.hide(); };
```

- [ ] **Step 4: Hide the map button during a live round**

In `controls.onLaunch(...)`, after `garage.setBusy(true);` (line 197), add:

```ts
  mapBtn.setVisible(false); // can't leave to the lobby mid-round
```

In `endRound(...)`, after `garage.setBusy(false);` (line 171), add:

```ts
  mapBtn.setVisible(true); // round over — the lobby is reachable again
```

- [ ] **Step 5: Branch the frame loop into lobby mode**

At the very top of `function frame() {`, immediately after the `const dt = …` line (line 208), insert the lobby branch and early-return:

```ts
  if (mode === "lobby") {
    const throttle = touchBrake ? -1 : holding ? 1 : 0;
    const steer = holding ? steerNorm : 0;
    drive = driveStep(drive, { throttle, steer }, dt, LOT_BOUNDS);

    car.update(dt);
    car.setEquity("idle", 1);
    car.group.position.set(drive.x, 0, drive.z);
    car.group.rotation.set(0, drive.heading, 0);
    car.setSteer(steer);

    const hit = entranceHit(drive.x, drive.z);
    lobbyHud.setPrompt(hit);
    if (hit) { doorDwell += dt; if (doorDwell > 0.45) { exitLobby(hit); } }
    else doorDwell = 0;

    lobby.update(dt);
    lobby.setRemoteCars([]); // multiplayer seam — empty today
    lobbyCam.update(ctx.camera, dt, drive.x, drive.z, drive.heading);

    if (post) post.render();
    else ctx.renderer.render(ctx.scene, ctx.camera);
    requestAnimationFrame(frame);
    return;
  }
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v "nitro?v=2"`
Expected: no output (clean). If `asset` is flagged as `string` vs `Asset`, confirm the assignment `asset = selected` compiles — `asset` is declared `let asset = "SOL"` (type `string`), and `Asset` is assignable to `string`, so this is fine.

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS (existing + the 4 new test files).

- [ ] **Step 8: Commit**

```bash
git add src/main.ts
git commit -m "feat(lobby): wire map button, free-roam mode, and market-entry into main loop"
```

---

### Task 8: Manual verification in preview

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server** (if not already running)

Run: `npm run dev` (serves http://localhost:3000/). Per the redline3d preview gotchas, if testing through Claude Preview, `preview_stop` + `preview_start` to bust the module cache.

- [ ] **Step 2: Verify the flow**

Confirm, out of a round:
- the map-pin button shows top-right, just left of the ♫ radio;
- clicking it hides the race HUD and drops into the neon lot with the three lit buildings (SOLANA / BITCOIN / ETHEREUM signs);
- hold-to-drive moves the car, drag steers, pulling back reverses, and the walls stop the car;
- driving into a building shows "ENTER {MARKET}" then lands back in the race with that market active (check the asset tab + price chip switched);
- the back button returns to the race without changing the market;
- starting a round (GO!) hides the map button; finishing a round restores it.

- [ ] **Step 3: Final commit (if any tuning edits were made)**

```bash
git add -A
git commit -m "chore(lobby): tune lot/drive feel after manual verification"
```

---

## Self-Review

- **Spec coverage:** map button (T5), free-roam lot + bounds (T1, T4), three themed buildings + signage (T2, T4), drive-into-building → market+race (T2, T7), back/exit without market change (T6, T7), multiplayer `remoteCars` seam (T4), HUD hide/show (T7), out-of-round gating (T7 steps 4). All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; every code step contains complete code; commands have expected output.
- **Type consistency:** `DriveState`/`DriveInput`/`Bounds` (T1) match their use in T7; `Asset` + `entranceHit` + `LOT_BOUNDS` (T2) match T6/T7; `createLobby`/`Lobby.setRemoteCars(RemoteCarState[])` (T4) match the `setRemoteCars([])` call (T7); `createMapButton` returns `{ el, setVisible }` (T5) used in T7; `createLobbyHud` returns `{ el, show, hide, setPrompt }` (T6) used in T7. Consistent.
