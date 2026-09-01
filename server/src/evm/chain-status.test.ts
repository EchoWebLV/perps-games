import { describe, expect, it } from "vitest";
import { makeEvmChainStatusReader, mapReceiptStatus } from "./chain-status.js";

const TX = "0x" + "1".repeat(64);

describe("mapReceiptStatus", () => {
  it("finalized only when success AND deep enough", () => {
    expect(mapReceiptStatus({ status: "success", blockNumber: 100n }, 120n, 12)).toBe("finalized");
    expect(mapReceiptStatus({ status: "success", blockNumber: 115n }, 120n, 12)).toBe("unknown");
    expect(mapReceiptStatus({ status: "reverted", blockNumber: 100n }, 120n, 12)).toBe("failed");
    expect(mapReceiptStatus(null, 120n, 12)).toBe("unknown");
  });

  it("is finalized exactly AT the confirmation depth", () => {
    expect(mapReceiptStatus({ status: "success", blockNumber: 108n }, 120n, 12)).toBe("finalized");
    expect(mapReceiptStatus({ status: "success", blockNumber: 109n }, 120n, 12)).toBe("unknown");
  });

  it("calls a revert failed no matter how shallow — funds did not move", () => {
    expect(mapReceiptStatus({ status: "reverted", blockNumber: 120n }, 120n, 12)).toBe("failed");
  });
});

describe("makeEvmChainStatusReader", () => {
  it("treats a not-found receipt as unknown (still pending)", async () => {
    const pub = {
      getTransactionReceipt: async () => {
        throw new Error("TransactionReceiptNotFoundError");
      },
      getBlockNumber: async () => 1n,
    };
    const read = makeEvmChainStatusReader(pub as never, 12);
    expect(await read(TX)).toBe("unknown");
  });

  it("reports finalized for a deep successful receipt", async () => {
    const pub = {
      getTransactionReceipt: async () => ({ status: "success", blockNumber: 100n }),
      getBlockNumber: async () => 120n,
    };
    const read = makeEvmChainStatusReader(pub as never, 12);
    expect(await read(TX)).toBe("finalized");
  });

  it("reports failed for a reverted receipt and unknown for a shallow one", async () => {
    const reverted = makeEvmChainStatusReader(
      { getTransactionReceipt: async () => ({ status: "reverted", blockNumber: 100n }), getBlockNumber: async () => 120n } as never,
      12,
    );
    expect(await reverted(TX)).toBe("failed");
    const shallow = makeEvmChainStatusReader(
      { getTransactionReceipt: async () => ({ status: "success", blockNumber: 119n }), getBlockNumber: async () => 120n } as never,
      12,
    );
    expect(await shallow(TX)).toBe("unknown");
  });

  it("passes the signature through as the receipt hash", async () => {
    const hashes: unknown[] = [];
    const pub = {
      getTransactionReceipt: async (q: { hash: string }) => {
        hashes.push(q.hash);
        return { status: "success", blockNumber: 100n };
      },
      getBlockNumber: async () => 120n,
    };
    await makeEvmChainStatusReader(pub as never, 12)(TX);
    expect(hashes).toEqual([TX]);
  });

  it("propagates a head-read failure (the poll retries) rather than guessing a status", async () => {
    const pub = {
      getTransactionReceipt: async () => ({ status: "success", blockNumber: 100n }),
      getBlockNumber: async () => {
        throw new Error("rpc down");
      },
    };
    await expect(makeEvmChainStatusReader(pub as never, 12)(TX)).rejects.toThrow("rpc down");
  });
});
