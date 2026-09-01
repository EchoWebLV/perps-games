import { describe, expect, it } from "vitest";
import { makeEvmTreasurySigner } from "./treasury-signer.js";

const TX = "0x" + "9".repeat(64);

function makeWallet() {
  const writes: Array<Record<string, unknown>> = [];
  const wallet = {
    chain: { id: 4663 },
    account: { address: "0xtreasury" },
    writeContract: async (args: Record<string, unknown>) => {
      writes.push(args);
      return TX;
    },
  };
  return { wallet, writes };
}

describe("makeEvmTreasurySigner", () => {
  it("sends an ERC-20 transfer of exact cents→base-units to the dest wallet", async () => {
    const { wallet, writes } = makeWallet();
    const signer = makeEvmTreasurySigner(wallet as never, { usdc: "0x" + "A".repeat(40) });
    const res = await signer.signAndSend({ destWallet: "0x" + "d".repeat(40), amountCents: 250, idempotencyKey: "k" });
    expect(res.txSig).toBe(TX);
    expect(res.providerTxId).toBeNull();
    expect(writes[0].functionName).toBe("transfer");
    expect(writes[0].address).toBe("0x" + "a".repeat(40)); // lowercased
    expect((writes[0].args as unknown[])[1]).toBe(2_500_000n); // $2.50 → 2.5 USDC base units
  });

  it("sends to the requested destination and leaves account/chain to the bound client", async () => {
    const { wallet, writes } = makeWallet();
    const dest = "0x" + "d".repeat(40);
    const signer = makeEvmTreasurySigner(wallet as never, { usdc: "0x" + "a".repeat(40) });
    await signer.signAndSend({ destWallet: dest, amountCents: 1, idempotencyKey: "k" });
    expect((writes[0].args as unknown[])[0]).toBe(dest);
    expect((writes[0].args as unknown[])[1]).toBe(10_000n); // 1 cent = 10_000 base units
    // The signing account and chain come from the TreasuryWalletClient itself, so they are NOT
    // restated per write — restating them is how a signer drifts from the configured treasury.
    expect(writes[0].account).toBeUndefined();
    expect(writes[0].chain).toBeUndefined();
  });

  it("throws on a fractional cents amount instead of rounding it onto the chain", async () => {
    const { wallet, writes } = makeWallet();
    const signer = makeEvmTreasurySigner(wallet as never, { usdc: "0x" + "a".repeat(40) });
    await expect(
      signer.signAndSend({ destWallet: "0x" + "d".repeat(40), amountCents: 2.5 as never, idempotencyKey: "k" }),
    ).rejects.toThrow(RangeError);
    expect(writes).toEqual([]); // nothing was broadcast
  });

  it("propagates a send failure instead of returning a fake signature", async () => {
    const wallet = {
      chain: { id: 4663 },
      account: { address: "0xtreasury" },
      writeContract: async () => {
        throw new Error("insufficient funds");
      },
    };
    const signer = makeEvmTreasurySigner(wallet as never, { usdc: "0x" + "a".repeat(40) });
    await expect(
      signer.signAndSend({ destWallet: "0x" + "d".repeat(40), amountCents: 100, idempotencyKey: "k" }),
    ).rejects.toThrow("insufficient funds");
  });
});
