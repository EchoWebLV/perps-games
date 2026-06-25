import { describe, expect, it, vi } from "vitest";
import {
  sweepToPlayBalance,
  InsufficientWalletBalanceError,
  SweepConfirmTimeoutError,
} from "./play-funding";

describe("sweepToPlayBalance", () => {
  it("sweeps the whole wallet balance and resolves once the server credits it", async () => {
    const buildDepositTx = vi.fn(async () => "txb64");
    const signAndSend = vi.fn(async () => "sig123");
    const pollServerBalance = vi.fn()
      .mockResolvedValueOnce(0)    // not credited yet
      .mockResolvedValueOnce(500); // credited

    const newBalance = await sweepToPlayBalance({
      walletBalanceCents: 500,
      startingServerBalance: 0,
      buildDepositTx,
      signAndSend,
      pollServerBalance,
      delay: async () => {},
      pollMs: 1,
    });

    expect(buildDepositTx).toHaveBeenCalledWith(500); // the FULL wallet balance
    expect(signAndSend).toHaveBeenCalledWith("txb64");
    expect(newBalance).toBe(500);
  });

  it("passes deposit objects through to the signing step", async () => {
    const deposit = { txBase64: "txb64", depositIntent: "di_123" };
    const buildDepositTx = vi.fn(async () => deposit);
    const signAndSend = vi.fn(async () => "sig123");

    const newBalance = await sweepToPlayBalance({
      walletBalanceCents: 500,
      startingServerBalance: 0,
      buildDepositTx,
      signAndSend,
      pollServerBalance: async () => 500,
      delay: async () => {},
    });

    expect(buildDepositTx).toHaveBeenCalledWith(500);
    expect(signAndSend).toHaveBeenCalledWith(deposit);
    expect(newBalance).toBe(500);
  });

  it("adds the swept amount on top of an existing in-game balance", async () => {
    const newBalance = await sweepToPlayBalance({
      walletBalanceCents: 300,
      startingServerBalance: 200,
      buildDepositTx: async () => "tx",
      signAndSend: async () => "sig",
      pollServerBalance: async () => 500, // 200 existing + 300 swept
      delay: async () => {},
    });
    expect(newBalance).toBe(500);
  });

  it("rejects before building a tx when the wallet has nothing to sweep", async () => {
    const buildDepositTx = vi.fn(async () => "tx");
    await expect(sweepToPlayBalance({
      walletBalanceCents: 0,
      startingServerBalance: 0,
      buildDepositTx,
      signAndSend: async () => "sig",
      pollServerBalance: async () => 0,
      delay: async () => {},
    })).rejects.toBeInstanceOf(InsufficientWalletBalanceError);
    expect(buildDepositTx).not.toHaveBeenCalled();
  });

  it("throws SweepConfirmTimeoutError when the credit never arrives in maxPolls", async () => {
    await expect(sweepToPlayBalance({
      walletBalanceCents: 100,
      startingServerBalance: 0,
      buildDepositTx: async () => "tx",
      signAndSend: async () => "sig",
      pollServerBalance: async () => 0, // never credited
      delay: async () => {},
      maxPolls: 3,
      pollMs: 1,
    })).rejects.toBeInstanceOf(SweepConfirmTimeoutError);
  });
});
