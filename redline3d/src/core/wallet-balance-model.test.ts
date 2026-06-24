import { describe, expect, it } from "vitest";
import { displayCashBalance } from "./wallet-balance-model";

describe("displayCashBalance", () => {
  it("uses the on-chain Privy wallet balance when it is available", () => {
    expect(displayCashBalance({ walletBalance: 100, fallbackBalance: 999 })).toBe(100);
  });

  it("falls back to the server balance only before a wallet balance is known", () => {
    expect(displayCashBalance({ walletBalance: null, fallbackBalance: 250 })).toBe(250);
  });
});
