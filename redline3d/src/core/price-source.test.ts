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

  it("restart() re-subscribes and reports NOT live until a fresh real tick (bfcache-frozen guard)", () => {
    // On bfcache restore the feed was stop()'d on pagehide, but the last real tick may still be
    // recent — live() would lie true on a frozen price and let a money round open. restart() must
    // resubscribe AND force not-live until a genuinely fresh tick lands.
    let emit: ((p: number) => void) | null = null;
    let connects = 0;
    const ps = createPriceSource({ connect: (cb) => { connects++; emit = cb; return () => {}; }, staleMs: 2500 });
    emit!(172);
    expect(ps.live()).toBe(true);
    ps.restart();                       // page restored from bfcache — feed suspended then resumed
    expect(connects).toBe(2);           // re-subscribed to the transport
    expect(ps.live()).toBe(false);      // frozen/just-restored → NOT live until a fresh tick
    emit!(173);                         // a real tick arrives on the new subscription
    expect(ps.live()).toBe(true);       // live again
  });

  it("stop() then no ticks → not live (subscription and sim both torn down)", () => {
    let emit: ((p: number) => void) | null = null;
    const ps = createPriceSource({ connect: (cb) => { emit = cb; return () => {}; }, staleMs: 2500, simSeed: 172 });
    emit!(172);
    expect(ps.live()).toBe(true);
    ps.stop();
    vi.advanceTimersByTime(5000);       // sim interval is gone → target must not drift after stop
    const frozen = ps.price();
    vi.advanceTimersByTime(5000);
    expect(ps.price()).toBe(frozen);    // no drift once stopped
    expect(ps.live()).toBe(false);
  });
});
