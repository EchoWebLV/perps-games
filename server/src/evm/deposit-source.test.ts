import { describe, expect, it } from "vitest";
import { inboundFromLog, makeEvmDepositSource } from "./deposit-source.js";

const USDC = "0x" + "a".repeat(40);
const TREASURY = "0x" + "b".repeat(40);
const FROM = "0x" + "c".repeat(40);

describe("inboundFromLog", () => {
  it("maps a Transfer log to InboundTransfer with lowercased addresses", () => {
    const log = {
      address: USDC,
      transactionHash: "0x" + "1".repeat(64),
      blockNumber: 100n,
      args: { from: FROM.toUpperCase().replace("0X", "0x"), to: TREASURY, value: 5_000_000n },
    };
    const t = inboundFromLog(log as never, { usdc: USDC, treasury: TREASURY });
    expect(t).toEqual({
      txSig: log.transactionHash,
      slot: 100,
      finalized: true,
      mint: USDC,
      tokenProgram: "erc20",
      destAta: TREASURY,
      sourceOwner: FROM,
      amountBaseUnits: 5_000_000n,
    });
  });

  it("lowercases a mixed-case configured usdc/treasury too", () => {
    const log = {
      address: USDC.toUpperCase(),
      transactionHash: "0x" + "2".repeat(64),
      blockNumber: 7n,
      args: { from: FROM, to: TREASURY, value: 1n },
    };
    const t = inboundFromLog(log as never, { usdc: USDC.toUpperCase(), treasury: TREASURY.toUpperCase() });
    expect(t.mint).toBe(USDC);
    expect(t.destAta).toBe(TREASURY);
  });
});

describe("makeEvmDepositSource", () => {
  it("fetches only up to latest - confirmations and reads token decimals", async () => {
    const calls: unknown[] = [];
    const pub = {
      getBlockNumber: async () => 120n,
      getLogs: async (q: unknown) => {
        calls.push(q);
        return [];
      },
      readContract: async () => 6,
    };
    const src = makeEvmDepositSource(pub as never, { usdc: USDC, treasury: TREASURY, confirmations: 20 });
    const page = await src.fetchInboundRange({ fromBlock: 90n });
    expect(page.toBlock).toBe(100n);
    expect((calls[0] as { fromBlock: bigint }).fromBlock).toBe(90n);
    expect((calls[0] as { toBlock: bigint }).toBlock).toBe(100n);
    expect(await src.tokenDecimals()).toBe(6);
  });

  it("returns an empty page without calling getLogs when the safe head is behind fromBlock", async () => {
    const pub = {
      getBlockNumber: async () => 100n,
      getLogs: async () => {
        throw new Error("must not");
      },
      readContract: async () => 6,
    };
    const src = makeEvmDepositSource(pub as never, { usdc: USDC, treasury: TREASURY, confirmations: 20 });
    const page = await src.fetchInboundRange({ fromBlock: 90n });
    expect(page.transfers).toEqual([]);
    expect(page.toBlock).toBe(89n);
  });

  it("maps logs to transfers and drops reorg-removed logs", async () => {
    const mk = (n: bigint, hash: string, removed?: boolean) => ({
      address: USDC,
      transactionHash: hash,
      blockNumber: n,
      removed,
      args: { from: FROM, to: TREASURY, value: 2_000_000n },
    });
    const pub = {
      getBlockNumber: async () => 120n,
      getLogs: async () => [mk(95n, "0x" + "1".repeat(64)), mk(96n, "0x" + "2".repeat(64), true)],
      readContract: async () => 6,
    };
    const src = makeEvmDepositSource(pub as never, { usdc: USDC, treasury: TREASURY, confirmations: 20 });
    const page = await src.fetchInboundRange({ fromBlock: 90n });
    expect(page.transfers.map((t) => t.txSig)).toEqual(["0x" + "1".repeat(64)]);
    expect(page.transfers[0].amountBaseUnits).toBe(2_000_000n);
  });

  it("queries only the configured token, the Transfer event, and to=treasury (all lowercased)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const pub = {
      getBlockNumber: async () => 120n,
      getLogs: async (q: Record<string, unknown>) => {
        calls.push(q);
        return [];
      },
      readContract: async () => 6,
    };
    const src = makeEvmDepositSource(pub as never, {
      usdc: USDC.toUpperCase(),
      treasury: TREASURY.toUpperCase(),
      confirmations: 20,
    });
    await src.fetchInboundRange({ fromBlock: 90n });
    expect(calls[0].address).toBe(USDC);
    expect((calls[0].args as { to: string }).to).toBe(TREASURY);
    expect((calls[0].event as { name: string }).name).toBe("Transfer");
  });

  it("reads the treasury balance in base units", async () => {
    const reads: Array<Record<string, unknown>> = [];
    const pub = {
      getBlockNumber: async () => 120n,
      getLogs: async () => [],
      readContract: async (q: Record<string, unknown>) => {
        reads.push(q);
        return 9_450_800n;
      },
    };
    const src = makeEvmDepositSource(pub as never, { usdc: USDC, treasury: TREASURY, confirmations: 20 });
    expect(await src.readTreasuryBaseUnits()).toBe(9_450_800n);
    expect(reads[0].functionName).toBe("balanceOf");
    expect((reads[0].args as unknown[])[0]).toBe(TREASURY);
  });
});
