export interface DisplayCashBalanceInput {
  walletBalance: number | null;
  fallbackBalance: number;
}

export function displayCashBalance(input: DisplayCashBalanceInput): number {
  return input.walletBalance ?? input.fallbackBalance;
}
