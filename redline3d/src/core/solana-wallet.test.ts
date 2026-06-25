import { describe, expect, it, vi } from "vitest";

describe("wallet target detection", () => {
  it("chooses seeker for capacitor android user agent", async () => {
    const { chooseWalletTarget } = await import("./solana-wallet");

    expect(
      chooseWalletTarget("auto", {
        userAgent: "Mozilla/5.0 Android Seeker",
        capacitorNative: true,
      }),
    ).toBe("seeker");
  });

  it("chooses web for ordinary browser", async () => {
    const { chooseWalletTarget } = await import("./solana-wallet");

    expect(
      chooseWalletTarget("auto", {
        userAgent: "Mozilla/5.0 Mac OS X",
        capacitorNative: false,
      }),
    ).toBe("web");
  });
});

describe("wallet loader", () => {
  it("loads the web port for web targets", async () => {
    const createWalletStandardPort = vi.fn(() => ({ kind: "web-standard" }));
    vi.doMock("./wallet-standard-port", () => ({ createWalletStandardPort }));
    vi.doMock("./mobile-wallet-port", () => ({
      createMobileWalletPort: vi.fn(() => ({ kind: "mobile-wallet-adapter" })),
    }));

    const { loadSolanaWalletPort } = await import("./solana-wallet");
    const port = await loadSolanaWalletPort("web");

    expect(port).toEqual({ kind: "web-standard" });
    expect(createWalletStandardPort).toHaveBeenCalledTimes(1);
  });

  it("loads the seeker port for seeker targets", async () => {
    const createMobileWalletPort = vi.fn(() => ({ kind: "mobile-wallet-adapter" }));
    vi.doMock("./wallet-standard-port", () => ({
      createWalletStandardPort: vi.fn(() => ({ kind: "web-standard" })),
    }));
    vi.doMock("./mobile-wallet-port", () => ({ createMobileWalletPort }));

    const { loadSolanaWalletPort } = await import("./solana-wallet");
    const port = await loadSolanaWalletPort("seeker");

    expect(port).toEqual({ kind: "mobile-wallet-adapter" });
    expect(createMobileWalletPort).toHaveBeenCalledTimes(1);
  });
});
