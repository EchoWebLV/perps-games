import { describe, expect, it, vi } from "vitest";
import { ensurePlayPayment, InsufficientWalletBalanceError, PlayPaymentConfirmationError } from "./play-payment";

describe("ensurePlayPayment", () => {
  it("sends exactly the play amount from the wallet and waits until the server can open the round", async () => {
    const pay = vi.fn(async () => {});
    const pollServerBalance = vi.fn(async () => 100);

    const balance = await ensurePlayPayment({
      walletBalance: 150,
      playAmount: 100,
      pay,
      pollServerBalance,
      delay: async () => {},
      maxPolls: 1,
    });

    expect(pay).toHaveBeenCalledWith(100);
    expect(pollServerBalance).toHaveBeenCalledOnce();
    expect(balance).toBe(100);
  });

  it("rejects before building a transaction when the Privy wallet does not cover the play amount", async () => {
    const pay = vi.fn(async () => {});

    await expect(ensurePlayPayment({
      walletBalance: 50,
      playAmount: 100,
      pay,
      pollServerBalance: async () => 0,
      delay: async () => {},
    })).rejects.toBeInstanceOf(InsufficientWalletBalanceError);

    expect(pay).not.toHaveBeenCalled();
  });

  it("reports a pending payment when server confirmation has not arrived yet", async () => {
    await expect(ensurePlayPayment({
      walletBalance: 100,
      playAmount: 100,
      pay: async () => {},
      pollServerBalance: async () => 0,
      delay: async () => {},
      maxPolls: 1,
    })).rejects.toBeInstanceOf(PlayPaymentConfirmationError);
  });
});
