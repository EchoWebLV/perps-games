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
 */
export function sol(units: number): string {
  return (units / 100).toFixed(2) + " SOL";
}
