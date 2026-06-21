/**
 * Money formatting. The soft-coin ledger is denominated in CENTS — 1 coin = $0.01 —
 * so settlement (`Math.floor(stake * equity * (1-edge))`) keeps cent-level resolution.
 * Every "$" the player sees for their BALANCE / STAKE / PAYOUT goes through here.
 * (The live SOL price and the green collectible coins are NOT cents — don't route them here.)
 */
export function usd(coins: number): string {
  return "$" + (coins / 100).toFixed(2);
}
