import { describe, expect, it, vi } from "vitest";
import { connectAndBindWallet, connectAndBindEvmWallet } from "./wallet-binding";
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
      bindWallet: vi.fn(async () => ({
        wallet: "Wallet1111111111111111111111111111111111",
        token: "wallet-token",
        userId: "wallet-user",
      })),
    };

    const out = await connectAndBindWallet({ port, api: api as any });

    expect(out).toEqual({
      address: "Wallet1111111111111111111111111111111111",
      label: "Phantom",
      session: { token: "wallet-token", userId: "wallet-user" },
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

const ADDR = "0xabcdef0000000000000000000000000000000001";
const SIG = `0x${"cd".repeat(65)}`;

function evmPort(address = ADDR) {
  return {
    connect: vi.fn(async () => ({ address })),
    signMessage: vi.fn(async (_message: string) => SIG),
  };
}

describe("connectAndBindEvmWallet", () => {
  it("connects, signs the challenge as EIP-191, and binds with the hex under `signature`", async () => {
    const port = evmPort();
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({
        challenge: "nonce-1",
        message: "sign me",
        wallet,
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: ADDR, token: "wallet-token", userId: "wallet-user" })),
    };

    const out = await connectAndBindEvmWallet({ port, api: api as any });

    expect(out).toEqual({ address: ADDR, session: { token: "wallet-token", userId: "wallet-user" } });
    expect(api.bindWalletChallenge).toHaveBeenCalledWith(ADDR);
    expect(port.signMessage).toHaveBeenCalledWith("sign me");
    // hex signature travels under `signature`; the base58 field stays a Solana-only concern
    expect(api.bindWallet).toHaveBeenCalledWith({ challenge: "nonce-1", signature: SIG });
  });

  it("omits the session when the server issues no token", async () => {
    const port = evmPort();
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({ challenge: "n", message: "m", wallet, expiresAt: "x" })),
      bindWallet: vi.fn(async () => ({ wallet: ADDR })),
    };

    await expect(connectAndBindEvmWallet({ port, api: api as any })).resolves.toEqual({ address: ADDR, session: undefined });
  });

  it("tolerates EIP-55 checksum casing in the challenge echo", async () => {
    const port = evmPort("0xABCDEF0000000000000000000000000000000001");
    const api = {
      bindWalletChallenge: vi.fn(async () => ({ challenge: "n", message: "m", wallet: ADDR, expiresAt: "x" })),
      bindWallet: vi.fn(async () => ({ wallet: ADDR })),
    };

    await expect(connectAndBindEvmWallet({ port, api: api as any })).resolves.toEqual({ address: ADDR, session: undefined });
  });

  it("rejects when the server challenge echoes a different wallet", async () => {
    const port = evmPort();
    const api = {
      bindWalletChallenge: vi.fn(async () => ({
        challenge: "n",
        message: "m",
        wallet: "0x0000000000000000000000000000000000000002",
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: ADDR })),
    };

    await expect(connectAndBindEvmWallet({ port, api: api as any })).rejects.toThrow("wallet_mismatch");
    expect(api.bindWallet).not.toHaveBeenCalled();
    expect(port.signMessage).not.toHaveBeenCalled();
  });

  it("never replays a challenge — a retry fetches a fresh nonce", async () => {
    const port = evmPort();
    let n = 0;
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({
        challenge: `nonce-${++n}`,
        message: `sign ${n}`,
        wallet,
        expiresAt: "x",
      })),
      bindWallet: vi
        .fn<(input: { challenge: string; signature?: string }) => Promise<{ wallet: string }>>()
        .mockRejectedValueOnce(new Error("bind_failed"))
        .mockResolvedValueOnce({ wallet: ADDR }),
    };

    await expect(connectAndBindEvmWallet({ port, api: api as any })).rejects.toThrow("bind_failed");
    await expect(connectAndBindEvmWallet({ port, api: api as any })).resolves.toEqual({ address: ADDR, session: undefined });

    expect(api.bindWalletChallenge).toHaveBeenCalledTimes(2);
    expect(api.bindWallet.mock.calls[0][0].challenge).toBe("nonce-1");
    expect(api.bindWallet.mock.calls[1][0].challenge).toBe("nonce-2");
    expect(port.signMessage.mock.calls[1][0]).toBe("sign 2"); // re-signed, not reused
  });
});
