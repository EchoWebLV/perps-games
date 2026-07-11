export type StakeCurrencyKey = "SOL";
export type StakeFundingMode = "native-wrap" | "spl-transfer";

export interface StakeCurrency {
  key: StakeCurrencyKey;
  symbol: string;
  mint: string;
  decimals: number;
  displayUnitDecimals: number;
  fundingMode: StakeFundingMode;
  initialBuyInBase: number;
}

export const ACTIVE_STAKE_CURRENCY: StakeCurrency = Object.freeze({
  key: "SOL",
  symbol: "SOL",
  mint: "So11111111111111111111111111111111111111112",
  decimals: 9,
  displayUnitDecimals: 2,
  fundingMode: "native-wrap",
  initialBuyInBase: 100_000_000,
});

export const basePerDisplayUnit = (currency = ACTIVE_STAKE_CURRENCY): number =>
  10 ** (currency.decimals - currency.displayUnitDecimals);

export const unitsToBase = (units: number, currency = ACTIVE_STAKE_CURRENCY): number =>
  Math.round(units * basePerDisplayUnit(currency));

export const baseToUnits = (base: bigint, currency = ACTIVE_STAKE_CURRENCY): number =>
  Number(base) / basePerDisplayUnit(currency);

export function formatStakeUnits(
  units: number,
  fractionDigits = 3,
  currency = ACTIVE_STAKE_CURRENCY,
): string {
  return `${(units / 10 ** currency.displayUnitDecimals).toFixed(fractionDigits)} ${currency.symbol}`;
}
