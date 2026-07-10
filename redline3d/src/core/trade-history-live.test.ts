import { describe, expect, it, vi } from "vitest";
import type { TradeHistoryItem, TradeRecordInput } from "./api";
import { createTradeHistoryRecorder, type TradeHistoryRecorder } from "./trade-history-recorder";
import { createTradeHistoryBridge } from "./trade-history-live";

const completedTrade: TradeRecordInput = {
  id: "11111111-1111-4111-8111-111111111111",
  asset: "SOL",
  dir: 1,
  lev: 250,
  stakeBase: 10_000_000,
  entryPrice: 150,
  exitPrice: 151,
  openedAt: "2025-07-10T10:40:00.000Z",
  outcome: "cashout",
  payoutBase: 11_000_000,
};

function fakeRecorder(overrides: Partial<TradeHistoryRecorder> = {}): TradeHistoryRecorder {
  return {
    begin: vi.fn(),
    complete: vi.fn(() => completedTrade),
    flush: vi.fn(async () => undefined),
    pending: vi.fn(() => 0),
    ...overrides,
  };
}

function memoryStore(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

const opened = {
  asset: "SOL" as const,
  dir: 1 as const,
  lev: 250,
  stakeBase: 10_000_000,
  entryPrice: 150,
  entryTs: 1_752_144_000,
};

const settled = {
  outcome: 0,
  outcomeName: "cashout",
  payout: 11_000_000n,
  exitHuman: 151,
};

describe("live trade history bridge", () => {
  it("begins with the confirmed chain entry timestamp", () => {
    const recorder = fakeRecorder();
    const bridge = createTradeHistoryBridge(recorder);

    bridge.begin(opened);

    expect(recorder.begin).toHaveBeenCalledWith({
      asset: "SOL",
      dir: 1,
      lev: 250,
      stakeBase: 10_000_000,
      entryPrice: 150,
      openedAt: "2025-07-10T10:40:00.000Z",
    });
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
    "falls back to the current time for an unusable entry timestamp (%s)",
    (entryTs) => {
      const recorder = fakeRecorder();
      const bridge = createTradeHistoryBridge(recorder, { now: () => 1_752_144_123_000 });

      bridge.begin({ ...opened, entryTs });

      expect(recorder.begin).toHaveBeenCalledWith(expect.objectContaining({
        openedAt: "2025-07-10T10:42:03.000Z",
      }));
    },
  );

  it("skips invalid open metadata without interrupting gameplay", () => {
    const recorder = fakeRecorder();
    const warn = vi.fn();
    const bridge = createTradeHistoryBridge(recorder, { warn });

    expect(() => bridge.begin({ ...opened, entryPrice: 0 })).not.toThrow();

    expect(recorder.begin).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[trade-history] skipped invalid confirmed open");
  });

  it.each([
    [0, "cashout", "cashout"],
    [1, "cap", "cap"],
    [2, "liq", "liq"],
    [3, "time", "time"],
    [99, "cap", "cap"],
    [2, "future", "liq"],
  ] as const)("maps settlement %s/%s to %s", (outcome, outcomeName, expected) => {
    const recorder = fakeRecorder();
    const bridge = createTradeHistoryBridge(recorder);
    bridge.begin(opened);

    bridge.settle({ ...settled, outcome, outcomeName });

    expect(recorder.complete).toHaveBeenCalledWith({
      outcome: expected,
      payoutBase: 11_000_000,
      exitPrice: 151,
    });
  });

  it.each([
    { ...settled, outcome: 99, outcomeName: "future" },
    { ...settled, outcome: 1, outcomeName: "liq" },
    { ...settled, exitHuman: 0 },
    { ...settled, payout: -1n },
    { ...settled, payout: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
  ])("skips invalid settlement metadata and still flushes older records", (result) => {
    const recorder = fakeRecorder();
    const warn = vi.fn();
    const bridge = createTradeHistoryBridge(recorder, { warn });
    bridge.begin(opened);

    expect(() => bridge.settle(result)).not.toThrow();

    expect(recorder.complete).not.toHaveBeenCalled();
    expect(recorder.flush).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[trade-history] skipped invalid settlement");
  });

  it.each([
    Symbol("bad-payout"),
    null,
    1.5,
    "2000000",
    { valueOf: () => 2_000_000 },
  ])("contains malformed runtime payout %s and still flushes older records", (payout) => {
    const recorder = fakeRecorder();
    const warn = vi.fn();
    const bridge = createTradeHistoryBridge(recorder, { warn });
    bridge.begin(opened);

    const malformed = { ...settled, payout } as unknown as Parameters<typeof bridge.settle>[0];
    expect(() => bridge.settle(malformed)).not.toThrow();

    expect(recorder.complete).not.toHaveBeenCalled();
    expect(recorder.flush).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[trade-history] skipped invalid settlement");
  });

  it("completes an active draft at most once", async () => {
    const recorder = fakeRecorder();
    const bridge = createTradeHistoryBridge(recorder);
    bridge.begin(opened);

    bridge.settle(settled);
    bridge.settle(settled);
    await bridge.flush();

    expect(recorder.complete).toHaveBeenCalledTimes(1);
    expect(recorder.flush).toHaveBeenCalledTimes(1);
  });

  it("contains begin and complete exceptions while still trying the old queue", () => {
    const warn = vi.fn();
    const beginFailure = new Error("begin_failed");
    const recorder = fakeRecorder({
      begin: vi.fn(() => { throw beginFailure; }),
    });
    const bridge = createTradeHistoryBridge(recorder, { warn });

    expect(() => bridge.begin(opened)).not.toThrow();
    expect(() => bridge.settle(settled)).not.toThrow();
    expect(recorder.complete).not.toHaveBeenCalled();
    expect(recorder.flush).toHaveBeenCalledTimes(1);

    const completeFailure = new Error("complete_failed");
    const completing = fakeRecorder({
      complete: vi.fn(() => { throw completeFailure; }),
    });
    const completingBridge = createTradeHistoryBridge(completing, { warn });
    completingBridge.begin(opened);

    expect(() => completingBridge.settle(settled)).not.toThrow();
    expect(completing.flush).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[trade-history] begin failed", beginFailure);
    expect(warn).toHaveBeenCalledWith("[trade-history] completion failed", completeFailure);
  });

  it("drains older records, retries a retained completion, then flushes the new record", async () => {
    const events: string[] = [];
    let attempts = 0;
    const recorder = fakeRecorder({
      complete: vi.fn(() => {
        events.push(`complete:${++attempts}`);
        if (attempts === 1) throw new Error("queue_order_exhausted");
        return completedTrade;
      }),
      flush: vi.fn(async () => { events.push("flush"); }),
    });
    const bridge = createTradeHistoryBridge(recorder, { warn: vi.fn() });
    bridge.begin(opened);

    bridge.settle(settled);
    await bridge.flush();

    expect(events).toEqual(["complete:1", "flush", "complete:2", "flush"]);
  });

  it("keeps a failed completion available for a later account-sync flush", async () => {
    let attempts = 0;
    const recorder = fakeRecorder({
      complete: vi.fn(() => {
        attempts += 1;
        if (attempts < 3) throw new Error("storage_busy");
        return completedTrade;
      }),
    });
    const bridge = createTradeHistoryBridge(recorder, { warn: vi.fn() });
    bridge.begin(opened);

    bridge.settle(settled);
    await bridge.flush();
    await bridge.flush();

    expect(recorder.complete).toHaveBeenCalledTimes(3);
    expect(recorder.flush).toHaveBeenCalledTimes(3);
  });

  it("does not overwrite a retained completion with the next confirmed open", async () => {
    const warn = vi.fn();
    const recorder = fakeRecorder({
      complete: vi.fn(() => { throw new Error("storage_busy"); }),
    });
    const bridge = createTradeHistoryBridge(recorder, { warn });
    bridge.begin(opened);
    bridge.settle(settled);
    await bridge.flush();

    bridge.begin({ ...opened, entryPrice: 152 });

    expect(recorder.begin).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[trade-history] skipped confirmed open while completion is pending");
  });

  it("contains synchronous and asynchronous flush failures", async () => {
    const warn = vi.fn();
    const syncFailure = new Error("sync_flush_failed");
    const asyncFailure = new Error("async_flush_failed");
    const syncBridge = createTradeHistoryBridge(fakeRecorder({
      flush: vi.fn(() => { throw syncFailure; }),
    }), { warn });
    const asyncBridge = createTradeHistoryBridge(fakeRecorder({
      flush: vi.fn(async () => { throw asyncFailure; }),
    }), { warn });

    await expect(syncBridge.flush()).resolves.toBeUndefined();
    await expect(asyncBridge.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[trade-history] flush failed", syncFailure);
    expect(warn).toHaveBeenCalledWith("[trade-history] flush failed", asyncFailure);
  });

  it("queues and uploads a completed trade through the real recorder", async () => {
    const recordTrade = vi.fn(async (input: TradeRecordInput): Promise<TradeHistoryItem> => ({
      ...input,
      walletPublicKey: "AliceWallet",
      pnlBase: input.payoutBase - input.stakeBase,
      settledAt: "2025-07-10T10:41:00.000Z",
    }));
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade },
      wallet: () => "AliceWallet",
      store: memoryStore(),
      newId: () => completedTrade.id,
      now: () => 1_752_144_060_000,
      realmId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const bridge = createTradeHistoryBridge(recorder);

    bridge.begin(opened);
    bridge.settle(settled);
    await bridge.flush();

    expect(recordTrade).toHaveBeenCalledWith(completedTrade, "AliceWallet");
    expect(recorder.pending()).toBe(0);
  });
});
