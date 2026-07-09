import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createMinimap, type MiniState } from "./minimap";

// The repo has no jsdom canvas, so hand-roll a fake canvas + recording 2D context (same
// node-env fake approach as coins.test.ts / mapbutton.test.ts). The context records every
// method call so we can assert "hidden → zero context work" and "identical state → one repaint".
function fakeCtx() {
  const calls: string[] = [];
  const rec = (name: string) => (..._a: unknown[]) => { calls.push(name); };
  return {
    calls,
    setTransform: rec("setTransform"),
    clearRect: rec("clearRect"),
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    stroke: rec("stroke"),
    fill: rec("fill"),
    fillRect: rec("fillRect"),
    fillText: rec("fillText"),
    arc: rec("arc"),
    save: rec("save"),
    restore: rec("restore"),
    translate: rec("translate"),
    rotate: rec("rotate"),
    closePath: rec("closePath"),
    setLineDash: rec("setLineDash"),
    createLinearGradient: (..._a: unknown[]) => { calls.push("createLinearGradient"); return { addColorStop: rec("addColorStop") }; },
    // settable style props the draw assigns to (plain fields — assignment is a no-op record-wise)
    fillStyle: "", strokeStyle: "", lineWidth: 0, lineJoin: "", shadowColor: "", shadowBlur: 0, font: "", textAlign: "",
  };
}

function fakeCanvas(w = 200, h = 100) {
  const ctx = fakeCtx();
  const canvas = {
    clientWidth: w, clientHeight: h, width: 0, height: 0,
    getContext: (_t: string) => ctx,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, ctx };
}

const g = globalThis as unknown as { window?: { devicePixelRatio: number } };
beforeEach(() => { g.window = { devicePixelRatio: 1 }; });
afterEach(() => { delete g.window; });

const baseState = (over: Partial<MiniState> = {}): MiniState => ({
  hist: [100, 101, 102, 103], inRun: false, equity: 1, entryPx: 0, liqPx: 0, dir: 1, ...over,
});

const repaints = (ctx: { calls: string[] }) => ctx.calls.filter((x) => x === "clearRect").length;

describe("createMinimap", () => {
  test("(a) hidden canvas (0 CSS box) returns before ANY 2D-context work", () => {
    const zeroW = fakeCanvas(0, 100);
    createMinimap(zeroW.canvas).draw(baseState());
    expect(zeroW.ctx.calls).toEqual([]); // display:none ancestor → not one context method touched

    const zeroH = fakeCanvas(200, 0);
    createMinimap(zeroH.canvas).draw(baseState());
    expect(zeroH.ctx.calls).toEqual([]);
  });

  test("(b) identical state drawn twice repaints only once", () => {
    const { canvas, ctx } = fakeCanvas();
    const mm = createMinimap(canvas);
    const s = baseState();
    mm.draw(s);
    expect(repaints(ctx)).toBe(1);
    mm.draw(s); // nothing moved → change detection skips
    expect(repaints(ctx)).toBe(1);
  });

  test("(b) each change in a drawn input forces a fresh repaint", () => {
    const { canvas, ctx } = fakeCanvas();
    const mm = createMinimap(canvas);
    mm.draw(baseState());                                             // 1
    mm.draw(baseState());                                             // skip (identical)
    expect(repaints(ctx)).toBe(1);
    mm.draw(baseState({ hist: [100, 101, 102, 103, 104] }));          // 2 — new price sample
    mm.draw(baseState({ hist: [100, 101, 102, 103, 104], inRun: true }));            // 3 — entered a run
    mm.draw(baseState({ hist: [100, 101, 102, 103, 104], inRun: true, equity: 0.5 })); // 4 — equity moved
    mm.draw(baseState({ hist: [100, 101, 102, 103, 104], inRun: true, equity: 0.5, liqPx: 99 })); // 5 — liq line moved
    mm.draw(baseState({ hist: [100, 101, 102, 103, 104], inRun: true, equity: 0.5, liqPx: 99, dir: -1 })); // 6 — flipped
    expect(repaints(ctx)).toBe(6);
  });

  test("(b) a CSS resize invalidates the cache even when state is identical", () => {
    const { canvas, ctx } = fakeCanvas();
    const mm = createMinimap(canvas);
    mm.draw(baseState());
    mm.draw(baseState());
    expect(repaints(ctx)).toBe(1);
    (canvas as unknown as { clientWidth: number }).clientWidth = 240; // window resized the CSS box
    mm.draw(baseState()); // same state, new size → must repaint
    expect(repaints(ctx)).toBe(2);
  });

  test("(c) pixelRatioCap defaults to 2 — a DPR-3 device is capped to a ×2 backing store", () => {
    g.window!.devicePixelRatio = 3;
    const { canvas } = fakeCanvas(200, 100);
    createMinimap(canvas).draw(baseState());
    expect(canvas.width).toBe(400);  // min(2, 3) = 2
    expect(canvas.height).toBe(200);
  });

  test("(c) a tighter pixelRatioCap (low tier 1.25) wins over a high device DPR", () => {
    g.window!.devicePixelRatio = 3;
    const { canvas } = fakeCanvas(200, 100);
    createMinimap(canvas, 1.25).draw(baseState());
    expect(canvas.width).toBe(250);  // min(1.25, 3) = 1.25
    expect(canvas.height).toBe(125);
  });

  test("(c) a device DPR under the cap is used as-is", () => {
    g.window!.devicePixelRatio = 1;
    const { canvas } = fakeCanvas(200, 100);
    createMinimap(canvas, 2).draw(baseState());
    expect(canvas.width).toBe(200);  // min(2, 1) = 1
    expect(canvas.height).toBe(100);
  });
});
