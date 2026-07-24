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

beforeEach(() => {
  installCanvasStub();
  vi.spyOn(GLTFLoader.prototype, "load").mockImplementation(() => undefined as never);
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
});
