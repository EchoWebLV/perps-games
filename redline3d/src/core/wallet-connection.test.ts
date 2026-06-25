import { describe, expect, it, vi } from "vitest";
import {
  ensureWalletConnection,
  hydrateBoundWallet,
  submitDeposit,
  WalletMismatchError,
} from "./wallet-connection";
import type { SolanaWalletPort } from "./solana-wallet";

function makePort(overrides: Partial<SolanaWalletPort> = {}): SolanaWalletPort {
  return {
    kind: "web-standard",
    connect: vi.fn(async () => ({ address: "Wallet1111111111111111111111111111111111", label: "Phantom" })),
    disconnect: vi.fn(),
    currentAddress: () => "Wallet1111111111111111111111111111111111",
    signMessage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    signTransaction: vi.fn(async () => "signed-tx"),
    ...overrides,
  };
}

describe("hydrateBoundWallet", () => {
  it("hydrates the server-bound wallet without loading a wallet SDK", async () => {
    const walletBalance = vi.fn(async () => ({
      wallet: "Wallet1111111111111111111111111111111111",
      balance: 4200,
    }));
    const loadWalletPort = vi.fn(() => makePort());

    const result = await hydrateBoundWallet({ walletBalance });

    expect(result).toEqual({
      boundWalletAddress: "Wallet1111111111111111111111111111111111",
      walletBalance: 4200,
    });
    expect(loadWalletPort).not.toHaveBeenCalled();
  });

  it("keeps the wallet unbound when the server has no wallet yet", async () => {
    const result = await hydrateBoundWallet({
      walletBalance: async () => ({ wallet: null, balance: 0 }),
    });

    expect(result).toEqual({
      boundWalletAddress: "",
      walletBalance: null,
    });
  });
});

describe("ensureWalletConnection", () => {
  it("reuses an already connected wallet without loading or rebinding", async () => {
    const port = makePort();
    const loadWalletPort = vi.fn(() => port);
    const connectAndBind = vi.fn();

    const result = await ensureWalletConnection({
      walletPort: port,
      connectedWalletAddress: "Wallet1111111111111111111111111111111111",
      boundWalletAddress: "Wallet1111111111111111111111111111111111",
      loadWalletPort,
      connectAndBindWallet: connectAndBind,
    });

    expect(loadWalletPort).not.toHaveBeenCalled();
    expect(port.connect).not.toHaveBeenCalled();
    expect(connectAndBind).not.toHaveBeenCalled();
    expect(result).toEqual({
      walletPort: port,
      connectedWalletAddress: "Wallet1111111111111111111111111111111111",
      boundWalletAddress: "Wallet1111111111111111111111111111111111",
    });
  });

  it("loads the wallet lazily and binds only when no wallet is bound on the server", async () => {
    const port = makePort();
    const loadWalletPort = vi.fn(() => port);
    const connectAndBind = vi.fn(async () => ({
      address: "Wallet1111111111111111111111111111111111",
      label: "Phantom",
    }));

    const result = await ensureWalletConnection({
      walletPort: null,
      connectedWalletAddress: "",
      boundWalletAddress: "",
      loadWalletPort,
      connectAndBindWallet: connectAndBind,
    });

    expect(loadWalletPort).toHaveBeenCalledTimes(1);
    expect(connectAndBind).toHaveBeenCalledWith(port);
    expect(result).toEqual({
      walletPort: port,
      connectedWalletAddress: "Wallet1111111111111111111111111111111111",
      boundWalletAddress: "Wallet1111111111111111111111111111111111",
    });
  });

  it("starts wallet connection before yielding the tap activation turn", async () => {
    const port = makePort();
    const loadWalletPort = vi.fn(() => port);
    const connectAndBind = vi.fn(async () => ({
      address: "Wallet1111111111111111111111111111111111",
      label: "Phantom",
    }));

    const pending = ensureWalletConnection({
      walletPort: null,
      connectedWalletAddress: "",
      boundWalletAddress: "",
      loadWalletPort,
      connectAndBindWallet: connectAndBind,
    });

    expect(loadWalletPort).toHaveBeenCalledTimes(1);
    expect(connectAndBind).toHaveBeenCalledWith(port);
    await pending;
  });

  it("reconnects and validates the bound wallet without rebinding", async () => {
    const port = makePort();
    const loadWalletPort = vi.fn(() => port);
    const connectAndBind = vi.fn();

    const result = await ensureWalletConnection({
      walletPort: null,
      connectedWalletAddress: "",
      boundWalletAddress: "Wallet1111111111111111111111111111111111",
      loadWalletPort,
      connectAndBindWallet: connectAndBind,
    });

    expect(loadWalletPort).toHaveBeenCalledTimes(1);
    expect(port.connect).toHaveBeenCalledTimes(1);
    expect(connectAndBind).not.toHaveBeenCalled();
    expect(result).toEqual({
      walletPort: port,
      connectedWalletAddress: "Wallet1111111111111111111111111111111111",
      boundWalletAddress: "Wallet1111111111111111111111111111111111",
    });
  });

  it("fails closed when the connected wallet does not match the bound wallet", async () => {
    const port = makePort({
      connect: vi.fn(async () => ({
        address: "Wallet2222222222222222222222222222222222",
        label: "Backpack",
      })),
    });

    await expect(
      ensureWalletConnection({
        walletPort: port,
        connectedWalletAddress: "",
        boundWalletAddress: "Wallet1111111111111111111111111111111111",
        loadWalletPort: vi.fn(() => port),
        connectAndBindWallet: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(WalletMismatchError);
  });
});

describe("submitDeposit", () => {
  it("falls back to depositSend when the wallet only supports signTransaction", async () => {
    const port = makePort({
      signAndSendTransaction: undefined,
      signTransaction: vi.fn(async () => "signed-tx"),
    });
    const depositSend = vi.fn(async () => ({ txSig: "sig123" }));

    const txSig = await submitDeposit({
      port,
      deposit: { txBase64: "txb64", depositIntent: "di_123" },
      api: { depositSend },
    });

    expect(port.signTransaction).toHaveBeenCalledWith("txb64");
    expect(depositSend).toHaveBeenCalledWith({
      depositIntent: "di_123",
      signedTxBase64: "signed-tx",
    });
    expect(txSig).toBe("sig123");
  });
});
