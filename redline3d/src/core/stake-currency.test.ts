import { describe, expect, it } from "vitest";
import {
  ACTIVE_STAKE_CURRENCY,
  baseToUnits,
  formatStakeUnits,
  unitsToBase,
} from "./stake-currency";

describe("active stake currency", () => {
  it("defines SOL without coupling consumers to nine decimals", () => {
    expect(ACTIVE_STAKE_CURRENCY).toMatchObject({
      key: "SOL",
      symbol: "SOL",
      mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
      displayUnitDecimals: 2,
      fundingMode: "native-wrap",
    });
  });

  it("converts centi-SOL display units and base units exactly", () => {
    expect(unitsToBase(1)).toBe(10_000_000);
    expect(baseToUnits(25_000_000n)).toBe(2.5);
    expect(formatStakeUnits(2.5, 3)).toBe("0.025 SOL");
  });
});
