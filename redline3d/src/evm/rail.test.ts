import { describe, expect, it, vi } from "vitest";
import { resolveChainRail, resolveEvmWalletKind, selectEvmWalletPort } from "./rail";
import type { EvmWalletPort } from "./wallet-port";

describe("resolveChainRail", () => {
  it("defaults to the EVM rail — Robinhood Chain is the live money rail", () => {
    expect(resolveChainRail({}, "")).toBe("evm");
  });

  it("VITE_CHAIN_RAIL=solana pins the parked rail; any other value stays evm", () => {
    expect(resolveChainRail({ VITE_CHAIN_RAIL: "solana" }, "")).toBe("solana");
    expect(resolveChainRail({ VITE_CHAIN_RAIL: "evm" }, "")).toBe("evm");
    expect(resolveChainRail({ VITE_CHAIN_RAIL: "bogus" }, "")).toBe("evm");
  });

  it("?rail= URL param wins over the env pin (Preview/automation escape hatch)", () => {
    expect(resolveChainRail({}, "?rail=solana")).toBe("solana");
    expect(resolveChainRail({ VITE_CHAIN_RAIL: "solana" }, "?rail=evm")).toBe("evm");
  });

  it("ignores unknown ?rail= values", () => {
    expect(resolveChainRail({ VITE_CHAIN_RAIL: "solana" }, "?rail=bogus")).toBe("solana");
    expect(resolveChainRail({}, "?rail=bogus")).toBe("evm");
  });
});

describe("resolveEvmWalletKind", () => {
  it("defaults to privy when a Privy app id is configured (the player path)", () => {
    expect(resolveEvmWalletKind({ VITE_PRIVY_APP_ID: "app123" }, "")).toBe("privy");
  });

  it("defaults to the dev key when no Privy app id exists", () => {
    expect(resolveEvmWalletKind({}, "")).toBe("dev");
  });

  it("VITE_WALLET overrides the app-id default", () => {
    expect(resolveEvmWalletKind({ VITE_WALLET: "dev", VITE_PRIVY_APP_ID: "app123" }, "")).toBe("dev");
    expect(resolveEvmWalletKind({ VITE_WALLET: "privy" }, "")).toBe("privy");
  });

  it("?wallet= URL param wins over everything", () => {
    expect(resolveEvmWalletKind({ VITE_WALLET: "privy", VITE_PRIVY_APP_ID: "app123" }, "?wallet=dev")).toBe("dev");
    expect(resolveEvmWalletKind({ VITE_WALLET: "dev" }, "?wallet=privy")).toBe("privy");
  });

  it("ignores unknown ?wallet= values", () => {
    expect(resolveEvmWalletKind({ VITE_PRIVY_APP_ID: "app123" }, "?wallet=bogus")).toBe("privy");
  });
});

function stubPort(kind: EvmWalletPort["kind"]): EvmWalletPort {
  return {
    kind,
    connect: async () => ({ address: "0x1" }),
    reconnect: async () => null,
    disconnect: async () => {},
    currentAddress: () => null,
    signMessage: async () => "0x",
    sendUsdcTransfer: async () => "0x",
    usdcBalance: async () => null,
  };
}

describe("selectEvmWalletPort", () => {
  it("honours the dev wallet without ever building the Privy port", () => {
    const createDev = vi.fn(() => stubPort("dev-evm"));
    const createPrivy = vi.fn(() => stubPort("privy-evm"));

    const port = selectEvmWalletPort({ env: { VITE_PRIVY_APP_ID: "app123" }, search: "?wallet=dev", createDev, createPrivy });

    expect(port.kind).toBe("dev-evm");
    expect(createDev).toHaveBeenCalledTimes(1);
    expect(createPrivy).not.toHaveBeenCalled();
  });

  it("builds the lazy Privy port for the player path", () => {
    const createDev = vi.fn(() => stubPort("dev-evm"));
    const createPrivy = vi.fn(() => stubPort("privy-evm"));

    const port = selectEvmWalletPort({ env: { VITE_PRIVY_APP_ID: "app123" }, search: "", createDev, createPrivy });

    expect(port.kind).toBe("privy-evm");
    expect(createPrivy).toHaveBeenCalledTimes(1);
    expect(createDev).not.toHaveBeenCalled();
  });
});
