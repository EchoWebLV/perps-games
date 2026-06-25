import { describe, it, expect } from "vitest";
import { BASE_UNITS_PER_CENT, USDC_DECIMALS, centsToBaseUnits, baseUnitsToCents, baseUnitsToCentsFloor } from "./usdc.js";

describe("usdc scale", () => {
  it("pins the USDC decimals + base-units-per-cent constants", () => {
    // USDC has 6 decimals; cents have 2 → 1 cent = 10^(6-2) = 10_000 base units.
    expect(USDC_DECIMALS).toBe(6);
    expect(BASE_UNITS_PER_CENT).toBe(10_000n);
  });

  it("converts cents → base units exactly (bigint in, bigint out)", () => {
    expect(centsToBaseUnits(0n)).toBe(0n);
    expect(centsToBaseUnits(1n)).toBe(10_000n); // $0.01
    expect(centsToBaseUnits(100n)).toBe(1_000_000n); // $1.00 == 1 USDC
    expect(centsToBaseUnits(500n)).toBe(5_000_000n); // $5.00 (max tiny cap)
  });

  it("round-trips whole cents", () => {
    for (const cents of [0n, 1n, 99n, 100n, 12_345n]) {
      expect(baseUnitsToCents(centsToBaseUnits(cents))).toBe(cents);
    }
  });

  it("THROWS on sub-cent dust — never rounds (spec §5: dust → fail)", () => {
    expect(() => baseUnitsToCents(10_001n)).toThrow(/dust|whole number of cents/i);
    expect(() => baseUnitsToCents(1n)).toThrow(/dust|whole number of cents/i);
    expect(() => baseUnitsToCents(9_999n)).toThrow(/dust|whole number of cents/i);
  });

  it("FLOORS sub-cent dust for display reads — never throws (real wallet balance, e.g. 9.4508 USDC)", () => {
    // 9.4508 USDC = 9_450_800 base units → 945 cents ($9.45), dust floored (stays on-chain).
    expect(baseUnitsToCentsFloor(9_450_800n)).toBe(945n);
    expect(baseUnitsToCentsFloor(10_001n)).toBe(1n);
    expect(baseUnitsToCentsFloor(9_999n)).toBe(0n);
    expect(baseUnitsToCentsFloor(0n)).toBe(0n);
    // exact whole cents still convert exactly
    expect(baseUnitsToCentsFloor(centsToBaseUnits(12_345n))).toBe(12_345n);
  });

  it("does not use Number anywhere (huge values survive exactly past 2^53)", () => {
    const bigCents = 90_071_992_547_409n; // > Number.MAX_SAFE_INTEGER in cents
    expect(baseUnitsToCents(centsToBaseUnits(bigCents))).toBe(bigCents);
  });

  it("handles negative deltas (reversals) and still catches their dust", () => {
    expect(centsToBaseUnits(-100n)).toBe(-1_000_000n);
    expect(baseUnitsToCents(-1_000_000n)).toBe(-100n);
    expect(() => baseUnitsToCents(-10_001n)).toThrow(/dust|whole number of cents/i);
  });
});
