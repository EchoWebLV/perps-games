import { describe, expect, it } from "vitest";
import { createMarketPulse } from "./market-pulse";

const input = (price: number, extra: Partial<{
  live: boolean;
  roundLive: boolean;
  buffer: number;
  dt: number;
}> = {}) => ({
  price,
  live: true,
  roundLive: false,
  buffer: 1,
  dt: 0.2,
  ...extra,
});

function trend(start: number, factor: number, count = 20) {
  const pulse = createMarketPulse();
  let price = start;
  pulse.update(input(price));
  let frame = pulse.update(input(price));
  for (let i = 0; i < count; i++) {
    price *= factor;
    frame = pulse.update(input(price));
  }
  return frame;
}

describe("Market Pulse", () => {
  it("keeps a flat price calm", () => {
    const pulse = createMarketPulse();
    for (let i = 0; i < 30; i++) pulse.update(input(100));
    expect(pulse.update(input(100)).volatility).toBe(0);
    expect(pulse.update(input(100)).momentum).toBe(0);
  });

  it("turns sustained upward and downward movement into signed momentum", () => {
    expect(trend(100, 1.0004).momentum).toBeGreaterThan(0.15);
    expect(trend(100, 0.9996).momentum).toBeLessThan(-0.15);
  });

  it("keeps percentage behavior independent of asset price", () => {
    const low = trend(100, 1.0004);
    const high = trend(100_000, 1.0004);
    expect(high.momentum).toBeCloseTo(low.momentum, 8);
    expect(high.volatility).toBeCloseTo(low.volatility, 8);
  });

  it("can be volatile without holding directional momentum", () => {
    const pulse = createMarketPulse();
    let price = 100;
    pulse.update(input(price));
    let frame = pulse.update(input(price));
    for (let i = 0; i < 30; i++) {
      price *= i % 2 === 0 ? 1.0004 : 1 / 1.0004;
      frame = pulse.update(input(price));
    }
    expect(frame.volatility).toBeGreaterThan(0.1);
    expect(Math.abs(frame.momentum)).toBeLessThan(0.08);
  });

  it("triggers one shock and respects the cooldown", () => {
    const pulse = createMarketPulse();
    pulse.update(input(100));
    const first = pulse.update(input(100.2));
    const repeated = pulse.update(input(100.4));
    expect(first.shockId).toBe(1);
    expect(first.shock).toBeGreaterThan(0);
    expect(repeated.shockId).toBe(1);
  });

  it("records the signed direction of each accepted shock", () => {
    const up = createMarketPulse();
    up.update(input(100));
    expect(up.update(input(100.2)).shockDirection).toBe(1);

    const down = createMarketPulse();
    down.update(input(100));
    expect(down.update(input(99.8)).shockDirection).toBe(-1);
  });

  it("decays market movement when the feed is stale", () => {
    const pulse = createMarketPulse();
    let price = 100;
    pulse.update(input(price));
    for (let i = 0; i < 20; i++) {
      price *= 1.0004;
      pulse.update(input(price));
    }
    let frame = pulse.update(input(price));
    expect(frame.momentum).toBeGreaterThan(0.15);
    for (let i = 0; i < 30; i++) {
      frame = pulse.update(input(price, { live: false, dt: 0.1 }));
    }
    expect(Math.abs(frame.momentum)).toBeLessThan(0.02);
    expect(frame.volatility).toBeLessThan(0.02);
  });

  it("derives danger only from a live Round below 35% buffer", () => {
    const pulse = createMarketPulse();
    const safe = pulse.update(input(100, { roundLive: true, buffer: 0.35, dt: 0.1 }));
    let danger = safe;
    for (let i = 0; i < 10; i++) {
      danger = pulse.update(input(100, { roundLive: true, buffer: 0, dt: 0.1 }));
    }
    let idle = danger;
    for (let i = 0; i < 10; i++) {
      idle = pulse.update(input(100, { roundLive: false, buffer: 0, dt: 0.1 }));
    }
    expect(safe.danger).toBe(0);
    expect(danger.danger).toBeGreaterThan(0.95);
    expect(idle.danger).toBeLessThan(0.05);
  });

  it("reset clears asset-specific observations", () => {
    const pulse = createMarketPulse();
    pulse.update(input(100));
    pulse.update(input(100.2));
    pulse.reset();
    const frame = pulse.update(input(50_000));
    expect(frame).toEqual({ volatility: 0, momentum: 0, shock: 0, shockId: 0, shockDirection: 0, danger: 0 });
  });
});
