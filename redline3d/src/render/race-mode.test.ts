// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createRaceGame, DEFAULT_GRID } from "./race-mode";

// The repo ships no jsdom canvas (see minimap.test.ts): getContext("2d") returns null, but the race
// sim builds cel-ramp + tail/shadow canvas textures at construction. Hand a Proxy that no-ops every
// 2D call (and returns a gradient/metrics stub where the code chains) so construction never throws.
// GLB loads are async and irrelevant to the sim math — the placeholder anchors race fine — so the
// loader is stubbed to a no-op (never resolves); no model ever attaches, no network is touched.
function installCanvasStub() {
  const grad = { addColorStop() {} };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "createLinearGradient" || prop === "createRadialGradient" || prop === "createPattern") return () => grad;
        if (prop === "measureText") return () => ({ width: 0 });
        if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
        return () => {};
      },
      set() {
        return true;
      },
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
}

// Captured GLB loads, resolvable on demand so the dispose-during-load tests can drive the async race.
interface PendingLoad { url: string; succeed(gltf: unknown): void }
let pending: PendingLoad[] = [];

// A tiny but REAL model so the toonify + disposeModel walk has geometry + a material to chew on.
function modelFixture() {
  const geometry = new THREE.BoxGeometry(2, 1, 4);
  const material = new THREE.MeshStandardMaterial();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));
  return { gltf: { scene: group }, group, geometry, material };
}

beforeEach(() => {
  installCanvasStub();
  pending = [];
  vi.spyOn(GLTFLoader.prototype, "load").mockImplementation((url, onLoad) => {
    pending.push({ url, succeed: onLoad as (gltf: unknown) => void });
    return undefined as never; // never auto-resolves; tests resolve pending[i] explicitly (or leave it)
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeGame(overrides: Record<string, unknown> = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const hudParent = document.createElement("div");
  return createRaceGame({ scene, camera, hudParent, grid: DEFAULT_GRID, seed: 42, lowTier: true, ...overrides });
}

describe("createRaceGame", () => {
  it("runs LOADING → MARKET → COUNTDOWN → RACING → FINISH deterministically", () => {
    const game = makeGame();
    expect(game.phase()).toBe("LOADING");
    for (let t = 0; t < 300 && game.phase() !== "FINISH"; t += 1 / 30) game.update(1 / 30);
    expect(game.phase()).toBe("FINISH");
    game.dispose();
  });

  it("settles exactly once under one giant throttled-tab dt", () => {
    const game = makeGame();
    while (game.phase() !== "RACING") game.update(1 / 30);
    game.update(600); // 10 minutes in one tick — hidden-tab reality
    expect(game.phase()).toBe("FINISH");
    game.dispose();
  });

  it("same seed → same finish order, every index present exactly once", () => {
    let a: number[] = [],
      b: number[] = [],
      c: number[] = [];
    const run = (seed: number, sink: (r: { finishOrder: number[] }) => void) => {
      const g = makeGame({ seed, onExit: sink });
      for (let t = 0; t < 300 && g.phase() !== "FINISH"; t += 1 / 30) g.update(1 / 30);
      g.requestExit();
      g.update(1 / 30);
      g.dispose();
    };
    run(7, (r) => (a = r.finishOrder));
    run(7, (r) => (b = r.finishOrder));
    run(8, (r) => (c = r.finishOrder));
    expect(a).toEqual(b);
    expect(a.length).toBe(DEFAULT_GRID.length);
    expect([...new Set(a)].length).toBe(a.length);
    // a different seed is allowed to (and here does) reorder the field
    expect(c.length).toBe(DEFAULT_GRID.length);
  });

  it("disposes a model that loaded before dispose — scene returns to pre-game state, no throw", () => {
    const scene = new THREE.Scene();
    const before = scene.children.length;
    const game = makeGame({ scene });
    expect(pending.length).toBe(DEFAULT_GRID.length); // one GLB request per grid car
    expect(scene.children.length).toBe(before + 1);   // the race group is mounted

    const fix = modelFixture();
    const disposeGeo = vi.spyOn(fix.geometry, "dispose");
    pending[0].succeed(fix.gltf);                      // a car model lands and attaches under its anchor
    expect(fix.group.parent).not.toBeNull();

    expect(() => game.dispose()).not.toThrow();
    expect(disposeGeo).toHaveBeenCalled();             // the attached model was torn down
    expect(scene.children.length).toBe(before);        // race group removed → pre-game state
  });

  it("ignores + disposes a model that resolves AFTER dispose (the mid-load guard), nothing left on scene", () => {
    const scene = new THREE.Scene();
    const before = scene.children.length;
    const game = makeGame({ scene });

    game.dispose();
    expect(scene.children.length).toBe(before);        // disposed → pre-game state already

    const fix = modelFixture();
    const disposeGeo = vi.spyOn(fix.geometry, "dispose");
    expect(() => pending[0].succeed(fix.gltf)).not.toThrow(); // late arrival hits `if (disposed)`
    expect(fix.group.parent).toBeNull();               // never attached to any anchor
    expect(disposeGeo).toHaveBeenCalled();             // late model was disposed, not leaked
    expect(scene.children.length).toBe(before);        // scene untouched by the late load
  });

  it("credits the podium owner in the results when the player's car places", () => {
    const grid = DEFAULT_GRID.map((g, i) => ({ ...g, isPlayer: i === 0, strength: i === 0 ? 99 : 1 }));
    const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    const hudParent = document.createElement("div");
    const game = createRaceGame({ scene, camera, hudParent, grid, seed: 3, lowTier: true, onExit: () => {} });
    for (let t = 0; t < 300 && game.phase() !== "FINISH"; t += 1 / 30) game.update(1 / 30);
    expect(game.phase()).toBe("FINISH");
    expect(hudParent.textContent).toContain("Podium — P1");
    game.dispose();
  });

  it("frees a loaded model's textures on dispose but spares the shared toon gradientMap", () => {
    const game = makeGame();
    const fix = modelFixture();
    // a GLB-owned map (must be freed → the leak this guards) and a stand-in for the shared toon cel
    // ramp on gradientMap (a module singleton reused game-wide → must survive one race teardown).
    const mapTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const rampTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    fix.material.map = mapTex;
    (fix.material as THREE.MeshStandardMaterial & { gradientMap: THREE.Texture }).gradientMap = rampTex;
    const mapDisposed = vi.spyOn(mapTex, "dispose");
    const rampDisposed = vi.spyOn(rampTex, "dispose");

    pending[0].succeed(fix.gltf); // model attaches + toonifies (the toon variant reuses .map)
    game.dispose();

    expect(mapDisposed).toHaveBeenCalled();      // GLB-owned texture freed → no per-race texture leak
    expect(rampDisposed).not.toHaveBeenCalled(); // gradientMap (shared cel ramp) left intact
  });
});
