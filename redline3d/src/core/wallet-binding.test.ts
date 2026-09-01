import { describe, expect, it, vi } from "vitest";
import { connectAndBindWallet, connectAndBindEvmWallet } from "./wallet-binding";
import type { SolanaWalletPort } from "./solana-wallet";

const SOL_ADDR = "Wallet1111111111111111111111111111111111";

/**
 * A server-shaped binding challenge. Mirrors `messageFor()` in server/src/auth/wallet-binding.ts —
 * the client asserts this shape before signing, so the test doubles must produce the real thing.
 */
const bindMessage = (wallet: string, nonce = "n1") => `Perps Rider wallet binding
Wallet: ${wallet}
Session: user-1
Nonce: ${nonce}
Expires: 2026-09-01T00:00:00.000Z`;

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
        message: bindMessage(SOL_ADDR),
        wallet: SOL_ADDR,
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
    expect(port.signMessage).toHaveBeenCalledWith(new TextEncoder().encode(bindMessage(SOL_ADDR)));
    expect(api.bindWallet).toHaveBeenCalledWith({
      challenge: "challenge",
      signatureBase58: "Ldp",
    });
  });

  it("refuses to sign arbitrary server text — the challenge must carry the known prefix", async () => {
    const port: SolanaWalletPort = {
      kind: "web-standard",
      connect: vi.fn(async () => ({ address: SOL_ADDR, label: "Phantom" })),
      disconnect: vi.fn(),
      currentAddress: () => SOL_ADDR,
      signMessage: vi.fn(async () => new Uint8Array([1, 2, 3])),
      signTransaction: vi.fn(),
    };
    const api = {
      bindWalletChallenge: vi.fn(async () => ({
        challenge: "challenge",
        // a MITM'd API's dream: a SIWE login for some other site, signed silently
        message: `evil.example wants you to sign in with your account\nWallet: ${SOL_ADDR}`,
        wallet: SOL_ADDR,
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: SOL_ADDR })),
    };

    await expect(connectAndBindWallet({ port, api: api as any })).rejects.toThrow(
      "bind_challenge_malformed",
    );
    expect(port.signMessage).not.toHaveBeenCalled();
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
        message: bindMessage(wallet),
        wallet,
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: ADDR, token: "wallet-token", userId: "wallet-user" })),
    };

    const out = await connectAndBindEvmWallet({ port, api: api as any });

    expect(out).toEqual({ address: ADDR, session: { token: "wallet-token", userId: "wallet-user" } });
    expect(api.bindWalletChallenge).toHaveBeenCalledWith(ADDR);
    expect(port.signMessage).toHaveBeenCalledWith(bindMessage(ADDR));
    // hex signature travels under `signature`; the base58 field stays a Solana-only concern
    expect(api.bindWallet).toHaveBeenCalledWith({ challenge: "nonce-1", signature: SIG });
  });

  it("omits the session when the server issues no token", async () => {
    const port = evmPort();
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({
        challenge: "n",
        message: bindMessage(wallet),
        wallet,
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: ADDR })),
    };

    await expect(connectAndBindEvmWallet({ port, api: api as any })).resolves.toEqual({ address: ADDR, session: undefined });
  });

  it("tolerates EIP-55 checksum casing in the challenge echo", async () => {
    const port = evmPort("0xABCDEF0000000000000000000000000000000001");
    const api = {
      bindWalletChallenge: vi.fn(async () => ({
        challenge: "n",
        message: bindMessage(ADDR),
        wallet: ADDR,
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: ADDR })),
    };

    await expect(connectAndBindEvmWallet({ port, api: api as any })).resolves.toEqual({ address: ADDR, session: undefined });
  });

  it("refuses to sign server text that is not the known binding challenge", async () => {
    const port = evmPort();
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({
        challenge: "n",
        // A MITM'd API cannot steal funds this way, but `showWalletUIs:false` means the player
        // sees NO prompt — so an attacker-supplied SIWE login would be signed silently.
        message: `evil.example wants you to sign in with your Ethereum account:\n${wallet}`,
        wallet,
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: ADDR })),
    };

    await expect(connectAndBindEvmWallet({ port, api: api as any })).rejects.toThrow(
      "bind_challenge_malformed",
    );
    expect(port.signMessage).not.toHaveBeenCalled();
    expect(api.bindWallet).not.toHaveBeenCalled();
  });

  it("refuses a well-prefixed challenge that does not name the connected wallet", async () => {
    const port = evmPort();
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({
        challenge: "n",
        message: bindMessage("0x0000000000000000000000000000000000000009"),
        wallet,
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: ADDR })),
    };

    await expect(connectAndBindEvmWallet({ port, api: api as any })).rejects.toThrow(
      "bind_challenge_malformed",
    );
    expect(port.signMessage).not.toHaveBeenCalled();
  });

  it("accepts checksum casing of the address INSIDE the message body", async () => {
    const port = evmPort();
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({
        challenge: "n",
        message: bindMessage("0xABCDEF0000000000000000000000000000000001"),
        wallet,
        expiresAt: "x",
      })),
      bindWallet: vi.fn(async () => ({ wallet: ADDR })),
    };

    await expect(connectAndBindEvmWallet({ port, api: api as any })).resolves.toEqual({
      address: ADDR,
      session: undefined,
    });
  });

  it("rejects when the server challenge echoes a different wallet", async () => {
    const port = evmPort();
    const api = {
      bindWalletChallenge: vi.fn(async () => ({
        challenge: "n",
        message: bindMessage(ADDR),
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
        message: bindMessage(wallet, `nonce-${n}`),
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
    expect(port.signMessage.mock.calls[1][0]).toBe(bindMessage(ADDR, "nonce-2")); // re-signed, not reused
  });
});
