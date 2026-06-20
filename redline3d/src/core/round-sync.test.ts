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
