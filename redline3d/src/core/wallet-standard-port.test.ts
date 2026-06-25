import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("createWalletStandardPort", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connects through a legacy injected Solana provider when no standard wallet registered yet", async () => {
    const connect = vi.fn(async () => ({
      publicKey: { toBase58: () => "Phantom111111111111111111111111111111111" },
    }));
    const walletsApi = {
      get: vi.fn(() => []),
      on: vi.fn(() => () => {}),
    };
    vi.doMock("@wallet-standard/app", () => ({ getWallets: () => walletsApi }));
    vi.stubGlobal("solana", {
      isPhantom: true,
      connect,
    });

    const { createWalletStandardPort } = await import("./wallet-standard-port");
    const port = createWalletStandardPort();

    await expect(port.connect()).resolves.toEqual({
      address: "Phantom111111111111111111111111111111111",
      label: "Phantom",
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
