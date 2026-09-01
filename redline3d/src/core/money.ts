import { SOL_STAKE_CURRENCY, formatStakeUnits } from "./stake-currency";

/**
 * Money formatting. The soft-coin ledger is denominated in CENTS — 1 coin = $0.01 —
 * so settlement (`Math.floor(stake * equity * (1-edge))`) keeps cent-level resolution.
 * Every "$" the player sees for their BALANCE / STAKE / PAYOUT goes through here.
 * (The live SOL price and the green collectible coins are NOT cents — don't route them here.)
 */
export function usd(coins: number): string {
  return "$" + (coins / 100).toFixed(2);
}

/**
 * Format a stake/balance/payout amount as SOL. The on-chain stake mint is wSOL, and the
 * play ledger is denominated in CENTI-SOL units (1 unit = 0.01 SOL) — the same ×100 scale
 * the cents model used — so this is the SOL-native sibling of `usd()`.
 *
 * Pinned to SOL_STAKE_CURRENCY, not the ACTIVE one: these two are the PARKED solana rail's
 * formatters. The live rail's money reads as dollars — route it through `usd()`.
 */
export function sol(units: number): string {
  return formatStakeUnits(units, 2, SOL_STAKE_CURRENCY);
}

/**
 * Like `sol()` but with 3 decimals — for small SOL amounts (the cash-out / bail payout and
 * the play balance) where 2-decimal cent rounding hides sub-0.01 SOL. `units` is centi-SOL
 * and may be fractional (pass the un-floored value so the extra digit is meaningful).
 */
export function sol3(units: number): string {
  return formatStakeUnits(units, 3, SOL_STAKE_CURRENCY);
}
