import { describe, it, expect, vi } from "vitest";
import * as walletSelect from "./wallet-select";
import { resolveWalletKind } from "./wallet-select";
import type { SolanaWalletPort } from "../core/solana-wallet";

describe("resolveWalletKind", () => {
  it("defaults to privy when a Privy app id is configured (the player path)", () => {
    expect(resolveWalletKind({ VITE_PRIVY_APP_ID: "app123" }, "")).toBe("privy");
  });

  it("defaults to dev-keypair when no Privy app id exists", () => {
    expect(resolveWalletKind({}, "")).toBe("dev");
  });

  it("VITE_WALLET overrides the app-id default", () => {
    expect(resolveWalletKind({ VITE_WALLET: "dev", VITE_PRIVY_APP_ID: "app123" }, "")).toBe("dev");
    expect(resolveWalletKind({ VITE_WALLET: "privy" }, "")).toBe("privy");
  });

  it("?wallet= URL param wins over everything (Preview/automation escape hatch)", () => {
    expect(resolveWalletKind({ VITE_WALLET: "privy", VITE_PRIVY_APP_ID: "app123" }, "?wallet=dev")).toBe("dev");
    expect(resolveWalletKind({ VITE_WALLET: "dev" }, "?wallet=privy")).toBe("privy");
  });

  it("ignores unknown ?wallet= values", () => {
    expect(resolveWalletKind({ VITE_PRIVY_APP_ID: "app123" }, "?wallet=bogus")).toBe("privy");
  });
});

describe("explicit Privy logout", () => {
  it("loads Privy and logs out even when the post-reload storage probe misses the session", async () => {
    const disconnect = vi.fn(async () => {});
    const port: SolanaWalletPort = {
      kind: "web-standard",
      connect: vi.fn(async () => ({ address: "PrivyWallet" })),
      reconnect: vi.fn(async () => null),
      disconnect,
      currentAddress: () => "PrivyWallet",
      signMessage: vi.fn(async () => new Uint8Array()),
      signTransaction: vi.fn(async (wire: string) => wire),
    };
    const load = vi.fn(async () => port);
    const createLazyPrivyPort = (walletSelect as unknown as {
      createLazyPrivyPort?: (deps: {
        load: () => Promise<SolanaWalletPort>;
        hasPersistedSession: () => boolean;
      }) => SolanaWalletPort;
    }).createLazyPrivyPort;

    expect(createLazyPrivyPort).toBeTypeOf("function");
    const lazy = createLazyPrivyPort!({ load, hasPersistedSession: () => false });
    await lazy.disconnect();

    expect(load).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
