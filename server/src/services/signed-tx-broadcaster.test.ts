import { describe, expect, it, vi } from "vitest";
import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { makeSignedTxBroadcaster } from "./signed-tx-broadcaster.js";

async function fixture(amount: bigint) {
  const feePayer = await generateKeyPairSigner();
  const authority = await generateKeyPairSigner();
  const ix = getTransferCheckedInstruction({
    source: address("11111111111111111111111111111112"),
    mint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    destination: address("11111111111111111111111111111113"),
    authority: createNoopSigner(authority.address),
    amount,
    decimals: 6,
  });
  const unsigned = compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({
      blockhash: "11111111111111111111111111111111" as never,
      lastValidBlockHeight: 10n,
    }, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  ));
  const signed = await partiallySignTransaction([feePayer.keyPair, authority.keyPair], unsigned);
  return {
    expectedTxBase64: getBase64EncodedWireTransaction(unsigned),
    signedTxBase64: getBase64EncodedWireTransaction(signed),
  };
}

describe("makeSignedTxBroadcaster", () => {
  it("broadcasts a fully signed transaction whose message matches the server-built transaction", async () => {
    const send = vi.fn(async () => "sig-123");
    const tx = await fixture(100n);

    const out = await makeSignedTxBroadcaster(send).broadcastSignedDeposit(tx);

    expect(out).toEqual({ txSig: "sig-123" });
    expect(send).toHaveBeenCalledWith(tx.signedTxBase64);
  });

  it("rejects a signed transaction whose message was mutated", async () => {
    const send = vi.fn(async () => "sig-123");
    const expected = await fixture(100n);
    const mutated = await fixture(200n);

    await expect(makeSignedTxBroadcaster(send).broadcastSignedDeposit({
      expectedTxBase64: expected.expectedTxBase64,
      signedTxBase64: mutated.signedTxBase64,
    })).rejects.toThrow("signed_transaction_message_mismatch");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a signed transaction that removed an existing server signature", async () => {
    const send = vi.fn(async () => "sig-123");
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
    const unsigned = compileTransaction(pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({
        blockhash: "11111111111111111111111111111111" as never,
        lastValidBlockHeight: 10n,
      }, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    ));
    const expected = await partiallySignTransaction([feePayer.keyPair], unsigned);
    const submitted = await partiallySignTransaction([feePayer.keyPair, authority.keyPair], unsigned);
    const submittedDecoded = getTransactionDecoder().decode(
      getBase64Encoder().encode(getBase64EncodedWireTransaction(submitted)),
    );
    const submittedWithoutServerSig = {
      ...submittedDecoded,
      signatures: {
        ...submittedDecoded.signatures,
        [feePayer.address]: null,
      },
    };

    await expect(makeSignedTxBroadcaster(send).broadcastSignedDeposit({
      expectedTxBase64: getBase64EncodedWireTransaction(expected),
      signedTxBase64: getBase64EncodedWireTransaction(submittedWithoutServerSig),
    })).rejects.toThrow("signed_transaction_missing_existing_signature");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a signed transaction that corrupts an existing server signature", async () => {
    const send = vi.fn(async () => "sig-123");
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
    const unsigned = compileTransaction(pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({
        blockhash: "11111111111111111111111111111111" as never,
        lastValidBlockHeight: 10n,
      }, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    ));
    const expected = await partiallySignTransaction([feePayer.keyPair], unsigned);
    const submitted = await partiallySignTransaction([feePayer.keyPair, authority.keyPair], unsigned);
    const submittedDecoded = getTransactionDecoder().decode(
      getBase64Encoder().encode(getBase64EncodedWireTransaction(submitted)),
    );
    const originalSignature = submittedDecoded.signatures[feePayer.address];
    expect(originalSignature).not.toBeNull();
    const corruptedSignature = new Uint8Array(originalSignature!);
    corruptedSignature[0] ^= 1;
    const submittedWithCorruptedServerSig = {
      ...submittedDecoded,
      signatures: {
        ...submittedDecoded.signatures,
        [feePayer.address]: corruptedSignature,
      },
    };

    await expect(makeSignedTxBroadcaster(send).broadcastSignedDeposit({
      expectedTxBase64: getBase64EncodedWireTransaction(expected),
      signedTxBase64: getBase64EncodedWireTransaction(submittedWithCorruptedServerSig),
    })).rejects.toThrow("signed_transaction_existing_signature_mismatch");
    expect(send).not.toHaveBeenCalled();
  });
});
