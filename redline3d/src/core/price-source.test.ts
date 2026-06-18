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
