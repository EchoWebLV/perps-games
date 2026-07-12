export interface DisplayCashBalanceInput {
  walletBalance: number | null;
  /** server-side ledger ("in-game") cash — the pocket GO stakes from. */
  inGameBalance: number;
}

// The player's money lives in two pockets: their on-chain wallet and the
// in-game ledger (charged from the wallet on play, paid back to it on cash-out).
// Show the SUM so neither pocket can hide funds — e.g. a recovered deposit that
// sits in the ledger must still be visible even while the wallet reads near-zero.
// Before the first wallet read (walletBalance == null) we show the in-game pocket
// alone rather than guessing the wallet.
export function displayCashBalance(input: DisplayCashBalanceInput): number {
  return (input.walletBalance ?? 0) + input.inGameBalance;
}

export interface PayoutWalletBalanceFloorInput {
  preCloseWalletBalance: number | null;
  payoutCoins: number;
}

export function payoutWalletBalanceFloor(input: PayoutWalletBalanceFloorInput): number | undefined {
  if (input.preCloseWalletBalance == null || input.payoutCoins <= 0) return undefined;
  return input.preCloseWalletBalance + input.payoutCoins;
}

/** Apply a confirmed native-SOL debit to the last known wallet display balance. */
export function applyConfirmedWalletSpend(
  knownWalletUnits: number,
  priceSol: number,
  displayUnitDecimals: number,
): number {
  const spentUnits = Math.round(priceSol * 10 ** displayUnitDecimals);
  return Math.max(0, knownWalletUnits - spentUnits);
}
