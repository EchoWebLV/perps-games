export type StakeCurrencyKey = "SOL" | "USD";
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

/**
 * The parked Solana rail's stake currency: wSOL, 9 decimals, play ledger in centi-SOL
 * (1 display unit = 0.01 SOL). Nothing on the live EVM rail reads this — the solana harness
 * (chain/config.ts, the ER game session, the SOL crate payment) imports it EXPLICITLY.
 */
export const SOL_STAKE_CURRENCY: StakeCurrency = Object.freeze({
  key: "SOL",
  symbol: "SOL",
  mint: "So11111111111111111111111111111111111111112",
  decimals: 9,
  displayUnitDecimals: 2,
  fundingMode: "native-wrap",
  initialBuyInBase: 100_000_000,
});

/**
 * The live rail's stake currency: the SERVER LEDGER, denominated in cents.
 *
 * decimals === displayUnitDecimals === 2 makes the base unit and the display unit the SAME
 * number — a cent — so `unitsToBase`/`baseToUnits` are identities and every `/v1` amountCents
 * crosses the client boundary without a scale change. USDC on Robinhood Chain has 6 decimals,
 * but that conversion (cents → USDC base units, ×10_000) belongs to the wallet port at the
 * moment of an actual on-chain transfer — the play ledger itself never leaves cents.
 *
 * `mint` is empty (the treasury address comes from the server, not a client constant) and
 * `initialBuyInBase` is 0 (there is no buy-in: the server debits the ledger at round open).
 */
export const USD_STAKE_CURRENCY: StakeCurrency = Object.freeze({
  key: "USD",
  symbol: "USD",
  mint: "",
  decimals: 2,
  displayUnitDecimals: 2,
  fundingMode: "spl-transfer",
  initialBuyInBase: 0,
});

/** The currency this build plays in. Robinhood Chain rail ⇒ the server's cent ledger. */
export const ACTIVE_STAKE_CURRENCY: StakeCurrency = USD_STAKE_CURRENCY;

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
