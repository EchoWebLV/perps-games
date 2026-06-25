import { describe, expect, it } from "vitest";
import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { makeFeePayerSignerFromKeyPair } from "./fee-payer-signer.js";

describe("makeFeePayerSignerFromKeyPair", () => {
  it("signs only the fee-payer slot and leaves user authority unsigned", async () => {
    const feePayer = await generateKeyPairSigner();
    const authority = await generateKeyPairSigner();
    const ix = getTransferCheckedInstruction({
      source: address("11111111111111111111111111111112"),
      mint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      destination: address("11111111111111111111111111111113"),
      authority: createNoopSigner(authority.address),
      amount: 100n,
      decimals: 6,
    });
    const txBase64 = getBase64EncodedWireTransaction(compileTransaction(pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({
        blockhash: "11111111111111111111111111111111" as never,
        lastValidBlockHeight: 10n,
      }, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    )));

    const signed = await makeFeePayerSignerFromKeyPair(feePayer.keyPair).signFeePayerTx(txBase64);
    const decoded = getTransactionDecoder().decode(Buffer.from(signed, "base64"));

    expect(decoded.signatures[feePayer.address]).not.toBeNull();
    expect(decoded.signatures[authority.address]).toBeNull();
  });
});
