import { describe, expect, it, vi } from "vitest";
import type { BlockhashLifetimeConstraint } from "@solana/kit";
import { makePrivyWithdrawSigner } from "./withdraw-signer.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TREASURY_ATA = "HutoZ391UtsKTwo5xdjZxmgRLKmRAMFPMhtcNTxQgtdF";
const TREASURY_OWNER = "53RbWfEX4iyikHQbySdyuNoL1eDmgm8V35s9XLSJ3g5r";
const WALLET_A = "ANcAfmuuko7VzC8vUZnn7bbg12BxyC9JNLCCJKQmbKf4";
const FIXED_LIFETIME: BlockhashLifetimeConstraint = {
  blockhash: "GfVcyD4kkTrj4bKc3wxW7hCgT7uxK1z6tWb5tWnVy8aF" as never,
  lastValidBlockHeight: 1000n,
};

describe("makePrivyWithdrawSigner", () => {
  it("asks Privy to sign and broadcasts a treasury to user USDC transfer", async () => {
    const signTransaction = vi.fn(async (_walletId: string, _input: any) => ({ signed_transaction: "signed-payout-tx" }));
    const sendSignedTransaction = vi.fn(async (_signedTxBase64: string) => "sig-payout");
    const privy = { wallets: () => ({ solana: () => ({ signTransaction }) }) };
    const signer = makePrivyWithdrawSigner({
      privy: privy as any,
      treasuryWalletId: "treasury-wallet-id",
      treasuryUsdcAta: TREASURY_ATA,
      treasuryOwner: TREASURY_OWNER,
      usdcMint: USDC_MINT,
      rpcUrl: "https://rpc.example",
      getLatestBlockhash: async () => FIXED_LIFETIME,
      sendSignedTransaction,
    });

    const res = await signer.signAndSend({ destWallet: WALLET_A, amountCents: 14, idempotencyKey: "round-payout:r1" });

    expect(res).toEqual({ txSig: "sig-payout", privyTxId: null });
    expect(signTransaction).toHaveBeenCalledOnce();
    const call = signTransaction.mock.calls[0]!;
    expect(call[0]).toBe("treasury-wallet-id");
    expect(call[1]).toMatchObject({
      idempotency_key: "round-payout:r1",
    });
    expect(call[1]).not.toHaveProperty("caip2");
    expect(call[1].transaction).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(sendSignedTransaction).toHaveBeenCalledWith("signed-payout-tx");
  });
});
