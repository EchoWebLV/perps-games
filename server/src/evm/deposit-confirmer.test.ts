import { describe, expect, it } from "vitest";
import { makeEvmDepositConfirmer } from "./deposit-confirmer.js";

describe("makeEvmDepositConfirmer", () => {
  const t = (block: number, sig: string) => ({
    txSig: sig,
    slot: block,
    finalized: true,
    mint: "0xa",
    tokenProgram: "erc20",
    destAta: "0xb",
    sourceOwner: "0xc",
    amountBaseUnits: 1_000_000n,
  });

  it("processes a range oldest-first and persists the cursor AFTER crediting", async () => {
    const seen: string[] = [];
    let stored: string | undefined;
    const confirmer = makeEvmDepositConfirmer({
      deposits: {
        recordInbound: async (x) => {
          seen.push(x.txSig);
          return { status: "credited", userId: "u", amountCents: 100 };
        },
      },
      source: { fetchInboundRange: async () => ({ transfers: [t(102, "0x2"), t(101, "0x1")], toBlock: 110n }) },
      store: { get: async () => stored, set: async (_k, v) => { stored = v; } },
      treasury: "0xB",
      pollMs: 60_000,
      startBlock: 100n,
    });
    await confirmer.tick();
    expect(seen).toEqual(["0x1", "0x2"]); // sorted oldest-first even though source returned newest-first
    expect(stored).toBe("110");
  });

  it("does not persist the cursor when crediting throws", async () => {
    let stored: string | undefined;
    const confirmer = makeEvmDepositConfirmer({
      deposits: { recordInbound: async () => { throw new Error("db down"); } },
      source: { fetchInboundRange: async () => ({ transfers: [t(101, "0x1")], toBlock: 110n }) },
      store: { get: async () => stored, set: async (_k, v) => { stored = v; } },
      treasury: "0xb",
      pollMs: 60_000,
      startBlock: 100n,
    });
    await expect(confirmer.tick()).rejects.toThrow();
    expect(stored).toBeUndefined();
  });

  it("resumes from cursor+1 and holds the cursor on an empty-behind page", async () => {
    const asked: bigint[] = [];
    let stored: string | undefined = "200";
    const confirmer = makeEvmDepositConfirmer({
      deposits: { recordInbound: async () => ({ status: "credited" }) },
      source: {
        fetchInboundRange: async ({ fromBlock }) => {
          asked.push(fromBlock);
          return { transfers: [], toBlock: fromBlock - 1n };
        },
      },
      store: { get: async () => stored, set: async (_k, v) => { stored = v; } },
      treasury: "0xb",
      pollMs: 60_000,
      startBlock: 100n,
    });
    await confirmer.tick();
    expect(asked).toEqual([201n]);
    expect(stored).toBe("200"); // unchanged
  });

  it("scans from startBlock on a fresh deploy (no cursor yet)", async () => {
    const asked: bigint[] = [];
    let stored: string | undefined;
    const confirmer = makeEvmDepositConfirmer({
      deposits: { recordInbound: async () => ({ status: "credited" }) },
      source: {
        fetchInboundRange: async ({ fromBlock }) => {
          asked.push(fromBlock);
          return { transfers: [], toBlock: 150n };
        },
      },
      store: { get: async () => stored, set: async (_k, v) => { stored = v; } },
      treasury: "0xb",
      pollMs: 60_000,
      startBlock: 100n,
    });
    await confirmer.tick();
    expect(asked).toEqual([100n]);
    expect(stored).toBe("150"); // an empty but caught-up range still advances the cursor
  });

  it("keys the cursor by the LOWERCASED treasury address", async () => {
    const keys: string[] = [];
    const confirmer = makeEvmDepositConfirmer({
      deposits: { recordInbound: async () => ({ status: "credited" }) },
      source: { fetchInboundRange: async () => ({ transfers: [], toBlock: 150n }) },
      store: {
        get: async (k) => { keys.push(k); return undefined; },
        set: async (k) => { keys.push(k); },
      },
      treasury: "0x" + "B".repeat(40),
      pollMs: 60_000,
      startBlock: 100n,
    });
    await confirmer.tick();
    expect(keys).toEqual(["0x" + "b".repeat(40), "0x" + "b".repeat(40)]);
  });

  it("re-reads the cursor each tick so it resumes from where the last tick stopped", async () => {
    const asked: bigint[] = [];
    let stored: string | undefined;
    const confirmer = makeEvmDepositConfirmer({
      deposits: { recordInbound: async () => ({ status: "credited" }) },
      source: {
        fetchInboundRange: async ({ fromBlock }) => {
          asked.push(fromBlock);
          return { transfers: [], toBlock: fromBlock + 9n };
        },
      },
      store: { get: async () => stored, set: async (_k, v) => { stored = v; } },
      treasury: "0xb",
      pollMs: 60_000,
      startBlock: 100n,
    });
    await confirmer.tick();
    await confirmer.tick();
    expect(asked).toEqual([100n, 110n]);
    expect(stored).toBe("119");
  });
});
