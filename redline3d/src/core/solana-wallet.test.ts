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

describe("wallet port preloader", () => {
  it("throws instead of awaiting when a tap arrives before the port is ready", async () => {
    const port = { kind: "web-standard" };
    let resolvePort: (value: typeof port) => void = () => {};
    const load = vi.fn(() => new Promise<typeof port>((resolve) => { resolvePort = resolve; }));
    const { createWalletPortPreloader } = await import("./solana-wallet");
    const preloader = createWalletPortPreloader(load as never);

    const pending = preloader.preload();

    expect(() => preloader.requireReady()).toThrow("wallet_port_loading");
    expect(load).toHaveBeenCalledTimes(1);

    resolvePort(port);
    await expect(pending).resolves.toBe(port);
    expect(preloader.requireReady()).toBe(port);
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

    expect(port).toMatchObject({ kind: "mobile-wallet-adapter" });
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

  it("falls back to the web port in auto mode when mobile connect cannot find a wallet", async () => {
    const mobilePort = {
      kind: "mobile-wallet-adapter",
      connect: vi.fn(async () => {
        throw new Error("wallet not found");
      }),
      disconnect: vi.fn(async () => {}),
      currentAddress: vi.fn(() => null),
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
    };
    const webPort = {
      kind: "web-standard",
      connect: vi.fn(async () => ({ address: "WebWallet11111111111111111111111111111111" })),
      disconnect: vi.fn(async () => {}),
      currentAddress: vi.fn(() => null),
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
    };
    const createMobileWalletPort = vi.fn(() => mobilePort);
    const createWalletStandardPort = vi.fn(() => webPort);

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

    await expect(port.connect()).resolves.toEqual({ address: "WebWallet11111111111111111111111111111111" });
    expect(mobilePort.connect).toHaveBeenCalledTimes(1);
    expect(createWalletStandardPort).toHaveBeenCalledTimes(1);
    expect(webPort.connect).toHaveBeenCalledTimes(1);
  });

  it("does not fall back for explicit seeker connect failures", async () => {
    const mobilePort = {
      kind: "mobile-wallet-adapter",
      connect: vi.fn(async () => {
        throw new Error("wallet not found");
      }),
      disconnect: vi.fn(async () => {}),
      currentAddress: vi.fn(() => null),
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
    };
    const createWalletStandardPort = vi.fn(() => ({ kind: "web-standard" }));

    vi.doMock("./wallet-standard-port", () => ({ createWalletStandardPort }));
    vi.doMock("./mobile-wallet-port", () => ({ createMobileWalletPort: vi.fn(() => mobilePort) }));
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Android Seeker",
    });
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
    });

    const { loadSolanaWalletPort } = await import("./solana-wallet");
    const port = await loadSolanaWalletPort("seeker");

    await expect(port.connect()).rejects.toThrow("wallet not found");
    expect(createWalletStandardPort).not.toHaveBeenCalled();
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

  it("keeps wallet SDK imports out of the main entrypoint", async () => {
    const fs = await import("node:fs/promises");
    const main = await fs.readFile(new URL("../main.ts", import.meta.url), "utf8");

    expect(main).not.toContain("@wallet-standard/app");
    expect(main).not.toContain("@solana-mobile/wallet-adapter-mobile");
    expect(main).toContain("loadSolanaWalletPort");
  });
});
