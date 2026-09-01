import { describe, expect, it } from "vitest";
import {
  ACTIVE_STAKE_CURRENCY,
  SOL_STAKE_CURRENCY,
  USD_STAKE_CURRENCY,
  baseToUnits,
  formatStakeUnits,
  unitsToBase,
} from "./stake-currency";

describe("SOL stake currency (parked solana rail)", () => {
  it("defines SOL without coupling consumers to nine decimals", () => {
    expect(SOL_STAKE_CURRENCY).toMatchObject({
      key: "SOL",
      symbol: "SOL",
      mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
      displayUnitDecimals: 2,
      fundingMode: "native-wrap",
    });
  });

  it("converts centi-SOL display units and base units exactly", () => {
    expect(unitsToBase(1, SOL_STAKE_CURRENCY)).toBe(10_000_000);
    expect(baseToUnits(25_000_000n, SOL_STAKE_CURRENCY)).toBe(2.5);
    expect(formatStakeUnits(2.5, 3, SOL_STAKE_CURRENCY)).toBe("0.025 SOL");
  });
});

describe("USD stake currency", () => {
  it("base unit IS the cent (server-ledger parity)", () => {
    expect(USD_STAKE_CURRENCY.decimals).toBe(2);
    expect(USD_STAKE_CURRENCY.displayUnitDecimals).toBe(2);
    expect(unitsToBase(250, USD_STAKE_CURRENCY)).toBe(250);
    expect(baseToUnits(250n, USD_STAKE_CURRENCY)).toBe(250);
  });

  it("USD is the active currency on the evm rail", () => {
    expect(ACTIVE_STAKE_CURRENCY.key).toBe("USD");
  });
});
