import { describe, expect, it, vi } from "vitest";
import {
  address,
  compileTransaction,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { buildTransferCheckedMessage } from "./transfer-tx.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";
import { centsToBaseUnits } from "../money/usdc.js";
import { makeTreasuryWithdrawSignerFromKeyPair } from "./treasury-signer.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TREASURY_USDC_ATA = "HutoZ391UtsKTwo5xdjZxmgRLKmRAMFPMhtcNTxQgtdF";
const BLOCKHASH = {
  blockhash: "11111111111111111111111111111111" as never,
  lastValidBlockHeight: 10n,
};

describe("makeTreasuryWithdrawSignerFromKeyPair", () => {
  it("builds the exact treasury→dest transferChecked, signs the treasury slot, and broadcasts it", async () => {
    const treasury = await generateKeyPairSigner();
    const destOwner = await generateKeyPairSigner();
    const sendTransaction = vi.fn(async () => "STUB_TX_SIG");

    const signer = makeTreasuryWithdrawSignerFromKeyPair(treasury.keyPair, {
      treasuryOwner: treasury.address,
      treasuryUsdcAta: TREASURY_USDC_ATA,
      usdcMint: USDC_MINT,
      getLatestBlockhash: async () => BLOCKHASH,
      sendTransaction,
    });

    const out = await signer.signAndSend({
      destWallet: destOwner.address,
      amountCents: 250, // $2.50
      idempotencyKey: "withdraw:test-id",
    });

    expect(out).toEqual({ txSig: "STUB_TX_SIG", providerTxId: null });
    expect(sendTransaction).toHaveBeenCalledTimes(1);

    // The broadcast payload must be the SAME message we'd build independently from the inputs
    // (proves source = treasury ATA, dest = derived dest ATA, amount = base units, decimals = 6),
    // and the treasury slot must be signed.
    const [destAta] = await findAssociatedTokenPda({
      owner: destOwner.address,
      mint: address(USDC_MINT),
      tokenProgram: address(LEGACY_TOKEN_PROGRAM),
    });
    const expectedWire = getBase64EncodedWireTransaction(
      compileTransaction(
        buildTransferCheckedMessage({
          source: address(TREASURY_USDC_ATA),
          mint: address(USDC_MINT),
          destination: destAta,
          authority: treasury.address,
          feePayer: treasury.address,
          amount: centsToBaseUnits(250n),
          decimals: 6,
          lifetime: BLOCKHASH,
        }),
      ),
    );

    const sentBase64 = (sendTransaction.mock.calls as unknown as [string[]])[0][0];
    const sentMsg = getTransactionDecoder().decode(Buffer.from(sentBase64, "base64"));
    const expectedMsg = getTransactionDecoder().decode(Buffer.from(expectedWire, "base64"));
    expect(Buffer.compare(Buffer.from(sentMsg.messageBytes), Buffer.from(expectedMsg.messageBytes))).toBe(0);
    expect(sentMsg.signatures[treasury.address]).not.toBeNull();
  });
});
