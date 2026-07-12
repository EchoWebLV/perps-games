import { describe, expect, it } from "vitest";
import { applyConfirmedWalletSpend, displayCashBalance, payoutWalletBalanceFloor } from "./wallet-balance-model";

describe("displayCashBalance", () => {
  it("sums the on-chain wallet and the in-game balance so no pocket is ever hidden", () => {
    // wallet $1.00 + in-game $0.75 → corner shows the real $1.75 total
    expect(displayCashBalance({ walletBalance: 100, inGameBalance: 75 })).toBe(175);
  });

  it("shows the in-game balance alone before a wallet balance is known", () => {
    expect(displayCashBalance({ walletBalance: null, inGameBalance: 250 })).toBe(250);
  });

  it("shows just the wallet when the in-game balance is zero (steady state)", () => {
    expect(displayCashBalance({ walletBalance: 100, inGameBalance: 0 })).toBe(100);
  });
});

describe("payoutWalletBalanceFloor", () => {
  it("waits for the pre-close wallet balance plus the payout", () => {
    expect(payoutWalletBalanceFloor({ preCloseWalletBalance: 86, payoutCoins: 23 })).toBe(109);
  });

  it("does not set a wallet floor when there is no payout or no wallet read", () => {
    expect(payoutWalletBalanceFloor({ preCloseWalletBalance: 86, payoutCoins: 0 })).toBeUndefined();
    expect(payoutWalletBalanceFloor({ preCloseWalletBalance: null, payoutCoins: 23 })).toBeUndefined();
  });
});

describe("confirmed native SOL spending", () => {
  it("subtracts an exact confirmed crate price in display units", () => {
    expect(applyConfirmedWalletSpend(1_000, 0.2, 2)).toBe(980);
  });

  it("never renders a negative wallet balance when the known value is stale", () => {
    expect(applyConfirmedWalletSpend(5, 0.1, 2)).toBe(0);
  });
});
