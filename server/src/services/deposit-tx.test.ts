import { describe, it, expect } from "vitest";
import type { BlockhashLifetimeConstraint } from "@solana/kit";
import { makeDepositTxBuilder } from "./deposit-tx.js";

// Real USDC mainnet mint + a real treasury ATA (structural fixtures; mint is boot-asserted live).
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TREASURY_ATA = "HutoZ391UtsKTwo5xdjZxmgRLKmRAMFPMhtcNTxQgtdF";
const WALLET_A = "ANcAfmuuko7VzC8vUZnn7bbg12BxyC9JNLCCJKQmbKf4";
const WALLET_B = "GfVcyD4kkTrj4bKc3wxW7hCgT7uxK1z6tWb5tWnVy8aF";

// Injected, fixed blockhash so the compiled bytes are deterministic across runs (no RPC).
const FIXED_LIFETIME: BlockhashLifetimeConstraint = {
  blockhash: "GfVcyD4kkTrj4bKc3wxW7hCgT7uxK1z6tWb5tWnVy8aF" as never,
  lastValidBlockHeight: 1000n,
};

function builder() {
  return makeDepositTxBuilder({
    usdcMint: USDC_MINT,
    treasuryUsdcAta: TREASURY_ATA,
    getLatestBlockhash: async () => FIXED_LIFETIME,
  });
}

describe("makeDepositTxBuilder", () => {
  it("returns a non-empty base64 txBase64 string", async () => {
    const { txBase64 } = await builder().buildForUser(WALLET_A, 100);
    expect(typeof txBase64).toBe("string");
    expect(txBase64.length).toBeGreaterThan(0);
    // base64 charset only (sanity that it's wire-encoded, not hex/raw)
    expect(txBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("is deterministic for identical inputs (idempotency-safe to rebuild)", async () => {
    const a = await builder().buildForUser(WALLET_A, 100);
    const b = await builder().buildForUser(WALLET_A, 100);
    expect(a.txBase64).toBe(b.txBase64);
  });

  it("is amount-sensitive — a different amountCents changes the bytes", async () => {
    const a = await builder().buildForUser(WALLET_A, 100);
    const b = await builder().buildForUser(WALLET_A, 250);
    expect(a.txBase64).not.toBe(b.txBase64);
  });

  it("is wallet-sensitive — a different userWallet changes the bytes (own-deposit isolation)", async () => {
    const a = await builder().buildForUser(WALLET_A, 100);
    const b = await builder().buildForUser(WALLET_B, 100);
    expect(a.txBase64).not.toBe(b.txBase64);
  });
});
