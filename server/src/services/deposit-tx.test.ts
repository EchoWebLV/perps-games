import { describe, it, expect, vi } from "vitest";
import { address, type BlockhashLifetimeConstraint } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { makeDepositTxBuilder } from "./deposit-tx.js";
import { buildUnsignedTransferCheckedWireTx } from "../solana/transfer-tx.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";
import { centsToBaseUnits, USDC_DECIMALS } from "../money/usdc.js";

// Real USDC mainnet mint + a real treasury ATA (structural fixtures; mint is boot-asserted live).
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TREASURY_ATA = "HutoZ391UtsKTwo5xdjZxmgRLKmRAMFPMhtcNTxQgtdF";
const TREASURY_OWNER = "53RbWfEX4iyikHQbySdyuNoL1eDmgm8V35s9XLSJ3g5r";
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

  it("can sponsor gas by signing the treasury fee-payer slot before returning the tx", async () => {
    const signFeePayerTx = vi.fn(async (txBase64: string) => `treasury-signed:${txBase64}`);
    const b = makeDepositTxBuilder({
      usdcMint: USDC_MINT,
      treasuryUsdcAta: TREASURY_ATA,
      treasuryOwner: TREASURY_OWNER,
      signFeePayerTx,
      getLatestBlockhash: async () => FIXED_LIFETIME,
    });
    const [sourceAta] = await findAssociatedTokenPda({
      owner: address(WALLET_A),
      mint: address(USDC_MINT),
      tokenProgram: address(LEGACY_TOKEN_PROGRAM),
    });
    const expectedUnsigned = buildUnsignedTransferCheckedWireTx({
      source: sourceAta,
      mint: address(USDC_MINT),
      destination: address(TREASURY_ATA),
      authority: address(WALLET_A),
      feePayer: address(TREASURY_OWNER),
      amount: centsToBaseUnits(100n),
      decimals: USDC_DECIMALS,
      lifetime: FIXED_LIFETIME,
    });

    const { txBase64 } = await b.buildForUser(WALLET_A, 100);

    expect(signFeePayerTx).toHaveBeenCalledWith(expectedUnsigned);
    expect(txBase64).toBe(`treasury-signed:${expectedUnsigned}`);
  });
});
