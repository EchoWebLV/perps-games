import { describe, expect, test, vi } from "vitest";
import { PublicKey, SystemInstruction } from "@solana/web3.js";
import {
  buildSolTransfer,
  payNativeSol,
  solToLamports,
  type SolPaymentIo,
} from "./sol-payment";

const FROM = new PublicKey("11111111111111111111111111111112");
const TO = new PublicKey("11111111111111111111111111111113");

describe("devnet SOL crate payment", () => {
  test("converts the configured prices to exact lamports", () => {
    expect(solToLamports(0.1)).toBe(100_000_000);
    expect(solToLamports(0.2)).toBe(200_000_000);
  });

  test("builds a native System Program transfer", () => {
    const tx = buildSolTransfer(FROM, TO, 100_000_000, "11111111111111111111111111111111");
    expect(tx.feePayer?.equals(FROM)).toBe(true);
    expect(tx.instructions).toHaveLength(1);
    const decoded = SystemInstruction.decodeTransfer(tx.instructions[0]);
    expect(decoded.fromPubkey.equals(FROM)).toBe(true);
    expect(decoded.toPubkey.equals(TO)).toBe(true);
    expect(decoded.lamports).toBe(100_000_000n);
  });

  test("signs, submits, and confirms before returning the signature", async () => {
    const io: SolPaymentIo = {
      latestBlockhash: vi.fn(async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 42,
      })),
      sign: vi.fn(async (tx) => tx),
      sendRaw: vi.fn(async () => "devnet-signature"),
      confirm: vi.fn(async () => ({ err: null })),
    };

    await expect(payNativeSol({ from: FROM, to: TO, sol: 0.1, io })).resolves.toBe("devnet-signature");
    expect(io.sign).toHaveBeenCalledTimes(1);
    expect(io.sendRaw).toHaveBeenCalledTimes(1);
    expect(io.confirm).toHaveBeenCalledWith({
      signature: "devnet-signature",
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 42,
    });
  });

  test("rejects a transfer that devnet did not confirm", async () => {
    const io: SolPaymentIo = {
      latestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 42 }),
      sign: async (tx) => tx,
      sendRaw: async () => "failed-signature",
      confirm: async () => ({ err: { InstructionError: [0, "Custom"] } }),
    };

    await expect(payNativeSol({ from: FROM, to: TO, sol: 0.2, io })).rejects.toThrow("sol_payment_unconfirmed");
  });
});
