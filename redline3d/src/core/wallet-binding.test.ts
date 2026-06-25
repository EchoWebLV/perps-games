import { describe, expect, it, vi } from "vitest";
import { connectAndBindWallet } from "./wallet-binding";
import type { SolanaWalletPort } from "./solana-wallet";

describe("connectAndBindWallet", () => {
  it("connects, signs the server challenge, and binds the wallet", async () => {
    const port: SolanaWalletPort = {
      kind: "web-standard",
      connect: vi.fn(async () => ({ address: "Wallet1111111111111111111111111111111111", label: "Phantom" })),
      disconnect: vi.fn(),
      currentAddress: () => "Wallet1111111111111111111111111111111111",
      signMessage: vi.fn(async () => new Uint8Array([1, 2, 3])),
      signTransaction: vi.fn(),
    };
    const api = {
      bindWalletChallenge: vi.fn(async () => ({
        challenge: "challenge",
        message: "message",
        wallet: "Wallet1111111111111111111111111111111111",
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: "Wallet1111111111111111111111111111111111" })),
    };

    const out = await connectAndBindWallet({ port, api: api as any });

    expect(out).toEqual({
      address: "Wallet1111111111111111111111111111111111",
      label: "Phantom",
    });
    expect(api.bindWalletChallenge).toHaveBeenCalledWith("Wallet1111111111111111111111111111111111");
    expect(port.signMessage).toHaveBeenCalledWith(new TextEncoder().encode("message"));
    expect(api.bindWallet).toHaveBeenCalledWith({ challenge: "challenge", signatureBase58: "Ldp" });
  });

  it("rejects when the server challenge echoes a different wallet", async () => {
    const port: SolanaWalletPort = {
      kind: "web-standard",
      connect: vi.fn(async () => ({ address: "Wallet1111111111111111111111111111111111", label: "Phantom" })),
      disconnect: vi.fn(),
      currentAddress: () => "Wallet1111111111111111111111111111111111",
      signMessage: vi.fn(async () => new Uint8Array([1, 2, 3])),
      signTransaction: vi.fn(),
    };
    const api = {
      bindWalletChallenge: vi.fn(async () => ({
        challenge: "challenge",
        message: "message",
        wallet: "Wallet2222222222222222222222222222222222",
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: "Wallet1111111111111111111111111111111111" })),
    };

    await expect(connectAndBindWallet({ port, api: api as any })).rejects.toThrow("wallet_mismatch");
    expect(api.bindWallet).not.toHaveBeenCalled();
  });
});
