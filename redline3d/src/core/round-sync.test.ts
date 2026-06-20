import { describe, it, expect } from "vitest";
import { clampInt, createCoalescer } from "./round-sync";

describe("clampInt", () => {
  it("clamps and integer-rounds into [10,1000]", () => {
    expect(clampInt(2000, 10, 1000)).toBe(1000); // nitro x2 overflow
    expect(clampInt(5, 10, 1000)).toBe(10);
    expect(clampInt(123.7, 10, 1000)).toBe(124);
  });
});

describe("coalescer (wall-clock, dedup on last-sent)", () => {
  it("emits at most one lever per window, only on a real change", () => {
    const out: number[] = [];
    const c = createCoalescer({ windowMs: 200, emit: (lev) => out.push(lev) });
    c.note(50, 0); c.pump(0);       // first sample emits the baseline (lastSampleMs starts at -Infinity)
    expect(out).toEqual([50]);
    c.note(50, 10); c.pump(210);    // unchanged vs last-sent -> no emit
    expect(out).toEqual([50]);
    c.note(250, 220); c.pump(250);  // only 40ms since the last sample -> window not elapsed
    expect(out).toEqual([50]);
    c.pump(420);                    // window elapsed -> emit 250
    expect(out).toEqual([50, 250]);
    c.note(300, 430); c.note(250, 440); c.pump(640); // blip-revert back to 250 (== last-sent) -> no emit
    expect(out).toEqual([50, 250]);
  });

  it("clamps the emitted value", () => {
    const out: number[] = [];
    const c = createCoalescer({ windowMs: 200, emit: (lev) => out.push(lev) });
    c.note(2000, 0); c.pump(200);
    expect(out).toEqual([1000]);
  });
});

import { createActionQueue } from "./round-sync";

describe("action queue (sequential, idempotent, ordered)", () => {
  it("sends one POST at a time in enqueue order, reusing actionId on retry", async () => {
    const calls: { actionId: string; kind: string }[] = [];
    let failFirst = true;
    const q = createActionQueue({
      send: async (a) => {
        calls.push({ actionId: a.actionId, kind: a.kind });
        if (a.kind === "lever" && failFirst) { failFirst = false; throw new Error("net"); }
      },
      maxRetries: 3, retryDelayMs: 0, delay: () => Promise.resolve(),
    });
    q.enqueue({ actionId: "id-lever", kind: "lever", lev: 100 });
    q.enqueue({ actionId: "id-flip", kind: "flip", dir: -1 });
    await q.drain();
    // lever was retried with the SAME id, then flip — order preserved
    expect(calls.map((c) => c.actionId)).toEqual(["id-lever", "id-lever", "id-flip"]);
  });

  it("drops an action after maxRetries and continues", async () => {
    const sent: string[] = [];
    const q = createActionQueue({
      send: async (a) => { if (a.kind === "lever") throw new Error("net"); sent.push(a.actionId); },
      maxRetries: 2, retryDelayMs: 0, delay: () => Promise.resolve(),
    });
    q.enqueue({ actionId: "bad", kind: "lever", lev: 100 });
    q.enqueue({ actionId: "ok", kind: "flip", dir: 1 });
    await q.drain();
    expect(sent).toEqual(["ok"]); // bad dropped, ok still sent
  });
});
