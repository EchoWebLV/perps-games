import { describe, it, expect } from "vitest";
import { perkEnvelope, CAR_PERKS, MAX_UPGRADE_LEVEL, ONCHAIN } from "./entitlements";

const L0 = { turbo: 0, tank: 0, suspension: 0 };
const LMAX = { turbo: 10, tank: 10, suspension: 10 };

describe("perkEnvelope", () => {
  it("stock car, no upgrades → base envelope", () => {
    const e = perkEnvelope(L0, {});
    expect(e.maxLev).toBe(1000);
    expect(e.maxDurSecs).toBe(60);
    expect(e.minLiqFp).toBe(200_000);
    expect(e.graceSecs).toBe(0);
    expect(e.slTpAllowed).toBe(false);
    expect(e.refundFp).toBe(0);
    expect(e.maxStakeUnits).toBe(10);
  });
  it("maxed upgrades → 1500× / 120s / 0.10 floor", () => {
    const e = perkEnvelope(LMAX, {});
    expect(e.maxLev).toBe(1500);
    expect(e.maxDurSecs).toBe(120);
    expect(e.minLiqFp).toBe(100_000);
  });
  it("Cybertruck baseLev floors leverage at 1500 with no turbo", () => {
    expect(perkEnvelope(L0, { baseLev: 1500 }).maxLev).toBe(1500);
  });
  it("Orion nitro doubles the ceiling (transient headroom the co-sign must allow)", () => {
    expect(perkEnvelope(LMAX, { ability: "nitro" }).maxLev).toBe(3000);
  });
  it("Six Wheeler: half ceiling, +50% time, bigger stake cap", () => {
    const e = perkEnvelope(LMAX, { ability: "sixWheeler" });
    expect(e.maxLev).toBe(750);
    expect(e.maxDurSecs).toBe(180);
    expect(e.maxStakeUnits).toBe(25);
  });
  it("Skull grants grace; Pink Rod grants SL/TP; Bedrock grants airbag refund", () => {
    expect(perkEnvelope(L0, { ability: "skull" }).graceSecs).toBe(2);
    expect(perkEnvelope(L0, { ability: "pinkRod" }).slTpAllowed).toBe(true);
    expect(perkEnvelope(L0, { ability: "airbag" }).refundFp).toBe(200_000);
  });
  it("NEVER exceeds the on-chain global clamps, for any car at max upgrades", () => {
    for (const car of Object.values(CAR_PERKS)) {
      const e = perkEnvelope(LMAX, car);
      expect(e.maxLev).toBeGreaterThanOrEqual(ONCHAIN.RMIN);
      expect(e.maxLev).toBeLessThanOrEqual(ONCHAIN.RMAX);
      expect(e.maxDurSecs).toBeGreaterThanOrEqual(ONCHAIN.MIN_DUR);
      expect(e.maxDurSecs).toBeLessThanOrEqual(ONCHAIN.MAX_DUR);
      expect(e.minLiqFp).toBeGreaterThanOrEqual(ONCHAIN.MIN_LIQ_FP);
      expect(e.minLiqFp).toBeLessThanOrEqual(ONCHAIN.MAX_LIQ_FP);
      expect(e.refundFp).toBeLessThanOrEqual(ONCHAIN.MAX_REFUND_FP);
    }
  });
  it("clamps out-of-range levels defensively", () => {
    expect(perkEnvelope({ turbo: 99, tank: -3, suspension: 999 }, {}).maxLev)
      .toBe(perkEnvelope({ turbo: MAX_UPGRADE_LEVEL, tank: 0, suspension: MAX_UPGRADE_LEVEL }, {}).maxLev);
  });
});
