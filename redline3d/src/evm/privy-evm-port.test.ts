import { describe, expect, it, vi } from "vitest";
import { createPrivyEvmPort, createLazyPrivyEvmPort } from "./privy-evm-port";
import type { EvmWalletPort } from "./wallet-port";

const SIG = `0x${"ab".repeat(65)}`; // 65-byte EIP-191 signature → 130 hex chars

function fakeIsland() {
  let addr: string | null = "0xAbCdEf0000000000000000000000000000000001";
  return {
    connect: vi.fn(async () => "0xAbCdEf0000000000000000000000000000000001"),
    signMessage: vi.fn(async (_message: string) => SIG),
    sendUsdcTransfer: vi.fn(async (_to: string, _amount: bigint) => "0xdeadbeef"),
    currentAddress: () => addr,
    reconnect: vi.fn(async () => addr),
    logout: vi.fn(async () => {
      addr = null;
    }),
  };
}

describe("privy EVM port", () => {
  it("connect resolves the embedded address, lowercased for the server invariant", async () => {
    const island = fakeIsland();
    const port = createPrivyEvmPort({ island });
    await expect(port.connect()).resolves.toEqual({ address: "0xabcdef0000000000000000000000000000000001" });
    expect(port.currentAddress()).toBe("0xabcdef0000000000000000000000000000000001");
    expect(port.kind).toBe("privy-evm");
  });

  it("signMessage delegates to the island and returns a 0x-hex 65-byte signature", async () => {
    const island = fakeIsland();
    const port = createPrivyEvmPort({ island });
    const sig = await port.signMessage("bind me");
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(island.signMessage).toHaveBeenCalledWith("bind me");
  });

  it("reconnect lowercases too; sendUsdcTransfer delegates; disconnect logs Privy out", async () => {
    const island = fakeIsland();
    const port = createPrivyEvmPort({ island });
    await expect(port.reconnect()).resolves.toEqual({ address: "0xabcdef0000000000000000000000000000000001" });
    await expect(port.sendUsdcTransfer("0xFEE1", 1_000_000n)).resolves.toBe("0xdeadbeef");
    expect(island.sendUsdcTransfer).toHaveBeenCalledWith("0xFEE1", 1_000_000n);
    await port.disconnect();
    expect(island.logout).toHaveBeenCalled();
    expect(port.currentAddress()).toBe(null);
  });

  it("usdcBalance reads for the connected address and swallows RPC failures", async () => {
    const island = fakeIsland();
    const readUsdcBalance = vi.fn(async () => 12_345_678n);
    const port = createPrivyEvmPort({ island, readUsdcBalance });
    await expect(port.usdcBalance()).resolves.toBe(12_345_678n);
    expect(readUsdcBalance).toHaveBeenCalledWith("0xabcdef0000000000000000000000000000000001");

    const broken = createPrivyEvmPort({
      island,
      readUsdcBalance: async () => {
        throw new Error("rpc down");
      },
    });
    await expect(broken.usdcBalance()).resolves.toBe(null);
  });

  it("usdcBalance is null with no wallet at all (nothing to read for)", async () => {
    const island = fakeIsland();
    await island.logout();
    const port = createPrivyEvmPort({ island, readUsdcBalance: async () => 1n });
    await expect(port.usdcBalance()).resolves.toBe(null);
  });
});

function fakeInnerPort(): EvmWalletPort {
  return {
    kind: "privy-evm",
    connect: vi.fn(async () => ({ address: "0xlazy" })),
    reconnect: vi.fn(async () => ({ address: "0xlazy" })),
    disconnect: vi.fn(async () => {}),
    currentAddress: () => "0xlazy",
    signMessage: vi.fn(async () => SIG),
    sendUsdcTransfer: vi.fn(async () => "0xtx"),
    usdcBalance: vi.fn(async () => 7n),
  };
}

describe("lazy privy EVM port", () => {
  it("mounts the island only on the first connect, then reuses it", async () => {
    const inner = fakeInnerPort();
    const load = vi.fn(async () => inner);
    const lazy = createLazyPrivyEvmPort({ load, hasPersistedSession: () => false });

    expect(load).not.toHaveBeenCalled();
    expect(lazy.currentAddress()).toBe(null); // no mount just to answer a getter

    await expect(lazy.connect()).resolves.toEqual({ address: "0xlazy" });
    await lazy.signMessage("m");
    expect(load).toHaveBeenCalledTimes(1);
    expect(lazy.currentAddress()).toBe("0xlazy");
  });

  it("reconnect with no persisted session resolves null WITHOUT mounting the island", async () => {
    const inner = fakeInnerPort();
    const load = vi.fn(async () => inner);
    const lazy = createLazyPrivyEvmPort({ load, hasPersistedSession: () => false });

    await expect(lazy.reconnect()).resolves.toBe(null);
    expect(load).not.toHaveBeenCalled();
    expect(inner.reconnect).not.toHaveBeenCalled();
  });

  it("reconnect mounts when Privy left a session behind", async () => {
    const inner = fakeInnerPort();
    const load = vi.fn(async () => inner);
    const lazy = createLazyPrivyEvmPort({ load, hasPersistedSession: () => true });

    await expect(lazy.reconnect()).resolves.toEqual({ address: "0xlazy" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("disconnect never trusts the storage probe — it mounts and asks Privy to clear its session", async () => {
    const inner = fakeInnerPort();
    const load = vi.fn(async () => inner);
    const lazy = createLazyPrivyEvmPort({ load, hasPersistedSession: () => false });

    await lazy.disconnect();
    expect(load).toHaveBeenCalledTimes(1);
    expect(inner.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does NOT memoize a failed mount — the next call retries and can succeed", async () => {
    const inner = fakeInnerPort();
    const load = vi
      .fn<() => Promise<EvmWalletPort>>()
      .mockRejectedValueOnce(new Error("privy_unreachable"))
      .mockResolvedValueOnce(inner);
    const lazy = createLazyPrivyEvmPort({ load, hasPersistedSession: () => false });

    await expect(lazy.connect()).rejects.toThrow("privy_unreachable");
    // a cached REJECTED promise would replay the same error here and brick sign-in for the session
    await expect(lazy.connect()).resolves.toEqual({ address: "0xlazy" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failed disconnect does not poison the later sign-in", async () => {
    // disconnect() always mounts. On a slow network that rejection used to be cached forever, so
    // every later Sign-in tap replayed it — the worst version of the same bug.
    const inner = fakeInnerPort();
    const load = vi
      .fn<() => Promise<EvmWalletPort>>()
      .mockRejectedValueOnce(new Error("privy_unreachable"))
      .mockResolvedValueOnce(inner);
    const lazy = createLazyPrivyEvmPort({ load, hasPersistedSession: () => false });

    await expect(lazy.disconnect()).rejects.toThrow("privy_unreachable");
    await expect(lazy.connect()).resolves.toEqual({ address: "0xlazy" });
  });

  it("concurrent callers still share ONE mount while it is in flight", async () => {
    const inner = fakeInnerPort();
    let release: (() => void) | null = null;
    const load = vi.fn(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return inner;
    });
    const lazy = createLazyPrivyEvmPort({ load, hasPersistedSession: () => false });

    const a = lazy.connect();
    const b = lazy.signMessage("m");
    expect(load).toHaveBeenCalledTimes(1); // de-duped, not one mount per caller
    release!();
    await Promise.all([a, b]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("usdcBalance stays null (no mount) until a wallet exists", async () => {
    const inner = fakeInnerPort();
    const load = vi.fn(async () => inner);
    const lazy = createLazyPrivyEvmPort({ load, hasPersistedSession: () => false });

    await expect(lazy.usdcBalance()).resolves.toBe(null);
    expect(load).not.toHaveBeenCalled();

    await lazy.connect();
    await expect(lazy.usdcBalance()).resolves.toBe(7n);
  });
});
