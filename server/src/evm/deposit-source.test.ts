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
      logIndex: 0,
      args: { from: FROM.toUpperCase().replace("0X", "0x"), to: TREASURY, value: 5_000_000n },
    };
    const t = inboundFromLog(log as never, { usdc: USDC, treasury: TREASURY });
    expect(t).toEqual({
      txSig: `${log.transactionHash}:0`,
      slot: 100,
      finalized: true,
      mint: USDC,
      tokenProgram: "erc20",
      destAta: TREASURY,
      sourceOwner: FROM,
      amountBaseUnits: 5_000_000n,
    });
  });

  it("lowercases a mixed-case log address and recipient", () => {
    const log = {
      address: USDC.toUpperCase(),
      transactionHash: "0x" + "2".repeat(64),
      blockNumber: 7n,
      logIndex: 0,
      args: { from: FROM, to: TREASURY.toUpperCase(), value: 1n },
    };
    const t = inboundFromLog(log as never, { usdc: USDC.toUpperCase(), treasury: TREASURY.toUpperCase() });
    expect(t.mint).toBe(USDC);
    expect(t.destAta).toBe(TREASURY);
  });

  it("reports the LOG's own token, not the configured one, so wrong_mint can actually fire", () => {
    const other = "0x" + "e".repeat(40);
    const log = {
      address: other,
      transactionHash: "0x" + "3".repeat(64),
      blockNumber: 8n,
      logIndex: 0,
      args: { from: FROM, to: TREASURY, value: 1_000_000n },
    };
    // An RPC that ignores the address filter must not have its log relabelled as the configured USDC:
    // the mint travels through verbatim, so Deposits quarantines it downstream as wrong_mint.
    const t = inboundFromLog(log as never, { usdc: USDC, treasury: TREASURY });
    expect(t.mint).toBe(other);
    expect(t.mint).not.toBe(USDC);
  });

  it("reports the LOG's own recipient, not the configured treasury, so wrong_dest can actually fire", () => {
    const other = "0x" + "f".repeat(40);
    const log = {
      address: USDC,
      transactionHash: "0x" + "4".repeat(64),
      blockNumber: 9n,
      logIndex: 0,
      args: { from: FROM, to: other, value: 1_000_000n },
    };
    const t = inboundFromLog(log as never, { usdc: USDC, treasury: TREASURY });
    expect(t.destAta).toBe(other);
    expect(t.destAta).not.toBe(TREASURY);
  });

  it("gives two logs in ONE transaction distinct ids so a batched send credits both", () => {
    // A batched smart-wallet / EIP-7702 tx can credit the treasury more than once in a single tx.
    // Keyed on transactionHash alone the second insert would hit the tx_sig unique index, return
    // {status:"duplicate"} and be silently swallowed — money received on-chain, never credited.
    const hash = "0x" + "5".repeat(64);
    const mk = (logIndex: number, from: string) => ({
      address: USDC,
      transactionHash: hash,
      blockNumber: 10n,
      logIndex,
      args: { from, to: TREASURY, value: 1_000_000n },
    });
    const a = inboundFromLog(mk(1, FROM) as never, { usdc: USDC, treasury: TREASURY });
    const b = inboundFromLog(mk(2, "0x" + "9".repeat(40)) as never, { usdc: USDC, treasury: TREASURY });
    expect(a.txSig).toBe(`${hash}:1`);
    expect(b.txSig).toBe(`${hash}:2`);
    expect(a.txSig).not.toBe(b.txSig);
    // Distinct senders is exactly why these are not aggregated into one transfer: each log is
    // attributed to its own sender, so each credits the right account.
    expect(a.sourceOwner).not.toBe(b.sourceOwner);
    // The explorer link is the part before ':'.
    expect(a.txSig.split(":")[0]).toBe(hash);
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
      logIndex: 0,
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
    expect(page.transfers.map((t) => t.txSig)).toEqual(["0x" + "1".repeat(64) + ":0"]);
    expect(page.transfers[0].amountBaseUnits).toBe(2_000_000n);
  });

  it("carries the real log's logIndex through into the deposit id", async () => {
    const hash = "0x" + "7".repeat(64);
    const pub = {
      getBlockNumber: async () => 120n,
      getLogs: async () => [
        { address: USDC, transactionHash: hash, blockNumber: 95n, logIndex: 3, args: { from: FROM, to: TREASURY, value: 1n } },
        { address: USDC, transactionHash: hash, blockNumber: 95n, logIndex: 4, args: { from: FROM, to: TREASURY, value: 1n } },
      ],
      readContract: async () => 6,
    };
    const src = makeEvmDepositSource(pub as never, { usdc: USDC, treasury: TREASURY, confirmations: 20 });
    const page = await src.fetchInboundRange({ fromBlock: 90n });
    expect(page.transfers.map((t) => t.txSig)).toEqual([`${hash}:3`, `${hash}:4`]);
  });

  it("refuses a non-positive maxBlockRange at construction", () => {
    const pub = { getBlockNumber: async () => 120n, getLogs: async () => [], readContract: async () => 6 };
    // A 0n cap makes every scan end before it began, freezing the cursor and halting deposits silently.
    expect(() =>
      makeEvmDepositSource(pub as never, { usdc: USDC, treasury: TREASURY, confirmations: 20, maxBlockRange: 0n }),
    ).toThrow("maxBlockRange must be positive");
    expect(() =>
      makeEvmDepositSource(pub as never, { usdc: USDC, treasury: TREASURY, confirmations: 20, maxBlockRange: -1n }),
    ).toThrow("maxBlockRange must be positive");
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

  it("caps a backlog wider than the default range and advances only to the cap", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const pub = {
      getBlockNumber: async () => 100_000n,
      getLogs: async (q: Record<string, unknown>) => {
        calls.push(q);
        return [];
      },
      readContract: async () => 6,
    };
    const src = makeEvmDepositSource(pub as never, { usdc: USDC, treasury: TREASURY, confirmations: 20 });
    const page = await src.fetchInboundRange({ fromBlock: 1n });
    // safe head is 99_980, but the default 10_000-block cap stops the scan at 1 + 10_000 - 1.
    expect(page.toBlock).toBe(10_000n);
    expect(calls[0].fromBlock).toBe(1n);
    expect(calls[0].toBlock).toBe(10_000n);
  });

  it("honours an explicit maxBlockRange and drains a backlog across ticks", async () => {
    const spans: Array<[bigint, bigint]> = [];
    const pub = {
      getBlockNumber: async () => 1_000n,
      getLogs: async (q: { fromBlock: bigint; toBlock: bigint }) => {
        spans.push([q.fromBlock, q.toBlock]);
        return [];
      },
      readContract: async () => 6,
    };
    const src = makeEvmDepositSource(pub as never, {
      usdc: USDC,
      treasury: TREASURY,
      confirmations: 20,
      maxBlockRange: 100n,
    });
    // safe head is 980. Each call advances by at most the cap, exactly as successive confirmer ticks would.
    const first = await src.fetchInboundRange({ fromBlock: 1n });
    expect(first.toBlock).toBe(100n);
    const second = await src.fetchInboundRange({ fromBlock: first.toBlock + 1n });
    expect(second.toBlock).toBe(200n);
    expect(spans).toEqual([
      [1n, 100n],
      [101n, 200n],
    ]);
  });

  it("does not cap when the safe head is nearer than the range limit", async () => {
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
      usdc: USDC,
      treasury: TREASURY,
      confirmations: 20,
      maxBlockRange: 10_000n,
    });
    const page = await src.fetchInboundRange({ fromBlock: 90n });
    expect(page.toBlock).toBe(100n); // safe head, not fromBlock + cap - 1
    expect(calls[0].toBlock).toBe(100n);
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
