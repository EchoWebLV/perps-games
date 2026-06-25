import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("loads the mobile port for auto targets on Android native", async () => {
    const createMobileWalletPort = vi.fn(() => ({ kind: "mobile-wallet-adapter" }));
    vi.doMock("./wallet-standard-port", () => ({
      createWalletStandardPort: vi.fn(() => ({ kind: "web-standard" })),
    }));
    vi.doMock("./mobile-wallet-port", () => ({ createMobileWalletPort }));
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Android Seeker",
    });
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
    });

    const { loadSolanaWalletPort } = await import("./solana-wallet");
    const port = await loadSolanaWalletPort("auto");

    expect(port).toEqual({ kind: "mobile-wallet-adapter" });
    expect(createMobileWalletPort).toHaveBeenCalledTimes(1);
  });

  it("falls back to the web port for auto targets when mobile loading fails", async () => {
    const mobileError = new Error("mobile unavailable");
    const createMobileWalletPort = vi.fn(() => {
      throw mobileError;
    });
    const createWalletStandardPort = vi.fn(() => ({ kind: "web-standard" }));

    vi.doMock("./wallet-standard-port", () => ({ createWalletStandardPort }));
    vi.doMock("./mobile-wallet-port", () => ({ createMobileWalletPort }));
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Android Seeker",
    });
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
    });

    const { loadSolanaWalletPort } = await import("./solana-wallet");
    const port = await loadSolanaWalletPort("auto");

    expect(port).toEqual({ kind: "web-standard" });
    expect(createMobileWalletPort).toHaveBeenCalledTimes(1);
    expect(createWalletStandardPort).toHaveBeenCalledTimes(1);
  });

  it("propagates mobile loading failures for seeker targets", async () => {
    const mobileError = new Error("mobile unavailable");
    const createMobileWalletPort = vi.fn(() => {
      throw mobileError;
    });
    const createWalletStandardPort = vi.fn(() => ({ kind: "web-standard" }));

    vi.doMock("./wallet-standard-port", () => ({ createWalletStandardPort }));
    vi.doMock("./mobile-wallet-port", () => ({ createMobileWalletPort }));
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Android Seeker",
    });
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
    });

    const { loadSolanaWalletPort } = await import("./solana-wallet");

    await expect(loadSolanaWalletPort("seeker")).rejects.toThrow("mobile unavailable");
    expect(createMobileWalletPort).toHaveBeenCalledTimes(1);
    expect(createWalletStandardPort).not.toHaveBeenCalled();
  });

  it("keeps wallet SDKs behind dynamic imports", async () => {
    const fs = await import("node:fs/promises");
    const main = await fs.readFile(new URL("../main.ts", import.meta.url), "utf8");

    expect(main).not.toContain("@wallet-standard/app");
    expect(main).not.toContain("@solana-mobile/wallet-adapter-mobile");
    expect(main).toContain("loadSolanaWalletPort");
  });
});
