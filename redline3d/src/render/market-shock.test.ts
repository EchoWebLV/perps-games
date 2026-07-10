import { describe, expect, it } from "vitest";
import { createMarketShockCore, marketShockColor, marketShockLightBoost } from "./market-shock";

describe("Market shock core", () => {
  it("triggers once for a new shock id and then decays", () => {
    const core = createMarketShockCore();
    core.update({ active: false, shockId: 0, strength: 0, direction: 0, reducedMotion: false }, 0.016);
    const first = core.update({ active: true, shockId: 1, strength: 0.8, direction: 1, reducedMotion: false }, 0.016);
    const repeated = core.update({ active: true, shockId: 1, strength: 0.8, direction: 1, reducedMotion: false }, 0.016);

    expect(first.active).toBe(true);
    expect(first.triggered).toBe(true);
    expect(first.cameraImpulse).toBeGreaterThan(0);
    expect(first.direction).toBe(1);
    expect(repeated.triggered).toBe(false);
    expect(repeated.cameraImpulse).toBe(0);

    let decayed = repeated;
    for (let i = 0; i < 50; i++) {
      decayed = core.update({ active: true, shockId: 1, strength: 0.8, direction: 1, reducedMotion: false }, 0.02);
    }
    expect(decayed.active).toBe(false);
    expect(decayed.flash).toBe(0);
  });

  it("keeps the visual but suppresses camera impulse for reduced motion", () => {
    const core = createMarketShockCore();
    const frame = core.update({ active: true, shockId: 1, strength: 1, direction: -1, reducedMotion: true }, 0.016);

    expect(frame.active).toBe(true);
    expect(frame.flash).toBeGreaterThan(0);
    expect(frame.cameraImpulse).toBe(0);
  });

  it("does not replay a shock that occurred outside a live round", () => {
    const core = createMarketShockCore();
    core.update({ active: false, shockId: 4, strength: 1, direction: 1, reducedMotion: false }, 0.016);
    const frame = core.update({ active: true, shockId: 4, strength: 1, direction: 1, reducedMotion: false }, 0.016);

    expect(frame.triggered).toBe(false);
    expect(frame.active).toBe(false);
  });

  it("uses directional market colors", () => {
    expect(marketShockColor(1)).toBe("#2effc5");
    expect(marketShockColor(-1)).toBe("#ff326f");
  });

  it("caps the roadside light pulse", () => {
    expect(marketShockLightBoost(0)).toBe(1);
    expect(marketShockLightBoost(0.5)).toBeCloseTo(1.9, 8);
    expect(marketShockLightBoost(2)).toBeCloseTo(2.8, 8);
  });
});
