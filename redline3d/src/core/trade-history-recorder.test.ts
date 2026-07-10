import { describe, expect, it, vi } from "vitest";
import { createTradeHistoryRecorder } from "./trade-history-recorder";

function memoryStore(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function throwingStore(): Storage {
  return {
    getItem: () => { throw new Error("get_failed"); },
    setItem: () => { throw new Error("set_failed"); },
    removeItem: () => { throw new Error("remove_failed"); },
    clear: () => {},
    key: () => null,
    get length() { return 0; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const draft = {
  asset: "SOL" as const,
  dir: 1 as const,
  lev: 250,
  stakeBase: 10_000_000,
  entryPrice: 150,
  openedAt: "2026-07-10T10:00:00.000Z",
};

const completion = {
  outcome: "cashout" as const,
  payoutBase: 11_000_000,
  exitPrice: 151,
};

describe("trade history recorder", () => {
  it("keeps a failed upload and removes it after a retry", async () => {
    const recordTrade = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({});
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store: memoryStore(),
      newId: () => "11111111-1111-4111-8111-111111111111",
    });
    recorder.begin(draft);
    expect(recorder.complete(completion)).not.toBeNull();

    await recorder.flush();
    expect(recorder.pending()).toBe(1);

    await recorder.flush();
    expect(recordTrade).toHaveBeenCalledTimes(2);
    expect(recorder.pending()).toBe(0);
  });

  it("completes one record at most once", () => {
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => "AliceWallet",
      store: memoryStore(),
      newId: () => "11111111-1111-4111-8111-111111111111",
    });
    recorder.begin(draft);

    expect(recorder.complete({ outcome: "liq", payoutBase: 0, exitPrice: 149 })).not.toBeNull();
    expect(recorder.complete({ outcome: "liq", payoutBase: 0, exitPrice: 149 })).toBeNull();
    expect(recorder.pending()).toBe(1);
  });

  it("retains the wallet outbox key captured when the draft began", () => {
    let wallet = "AliceWallet";
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => wallet,
      store: memoryStore(),
      newId: () => "11111111-1111-4111-8111-111111111111",
    });
    recorder.begin(draft);

    wallet = "BobWallet";
    expect(recorder.complete(completion)).not.toBeNull();
    expect(recorder.pending()).toBe(0);

    wallet = "AliceWallet";
    expect(recorder.pending()).toBe(1);
  });

  it("stops without removing Alice records when the wallet switches during an upload", async () => {
    let wallet = "AliceWallet";
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const recordTrade = vi.fn(async () => {
      wallet = "BobWallet";
      return {};
    });
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => wallet,
      store: memoryStore(),
      newId: () => ids.shift()!,
    });
    for (const exitPrice of [151, 152]) {
      recorder.begin(draft);
      recorder.complete({ ...completion, exitPrice });
    }

    await recorder.flush();

    expect(recordTrade).toHaveBeenCalledTimes(1);
    expect(recordTrade).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      "AliceWallet",
    );
    wallet = "AliceWallet";
    expect(recorder.pending()).toBe(2);
  });

  it("flushes Bob independently while Alice is still in flight", async () => {
    let wallet = "AliceWallet";
    const aliceUpload = deferred<unknown>();
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const recordTrade = vi.fn((record: { id: string }, _expectedWallet?: string) =>
      record.id === "11111111-1111-4111-8111-111111111111"
        ? aliceUpload.promise
        : Promise.resolve({}));
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => wallet,
      store: memoryStore(),
      newId: () => ids.shift()!,
    });
    recorder.begin(draft);
    recorder.complete(completion);
    const aliceFlush = recorder.flush();

    wallet = "BobWallet";
    recorder.begin(draft);
    recorder.complete(completion);
    const bobFlush = recorder.flush();
    await Promise.resolve();

    aliceUpload.resolve({});
    await Promise.all([aliceFlush, bobFlush]);

    expect(bobFlush).not.toBe(aliceFlush);
    expect(recordTrade.mock.calls.map(([record, expectedWallet]) => [record.id, expectedWallet])).toEqual([
      ["11111111-1111-4111-8111-111111111111", "AliceWallet"],
      ["22222222-2222-4222-8222-222222222222", "BobWallet"],
    ]);
    expect(recorder.pending()).toBe(0);
    wallet = "AliceWallet";
    expect(recorder.pending()).toBe(1);
  });

  it("keeps draining records appended during an active flush", async () => {
    const firstUpload = deferred<unknown>();
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const recordTrade = vi.fn((record: { id: string }, _expectedWallet?: string) =>
      record.id === "11111111-1111-4111-8111-111111111111"
        ? firstUpload.promise
        : Promise.resolve({}));
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store: memoryStore(),
      newId: () => ids.shift()!,
    });
    recorder.begin(draft);
    recorder.complete(completion);
    const flushing = recorder.flush();

    recorder.begin(draft);
    recorder.complete({ ...completion, exitPrice: 152 });
    firstUpload.resolve({});
    await flushing;

    expect(recordTrade.mock.calls.map(([record, expectedWallet]) => [record.id, expectedWallet])).toEqual([
      ["11111111-1111-4111-8111-111111111111", "AliceWallet"],
      ["22222222-2222-4222-8222-222222222222", "AliceWallet"],
    ]);
    expect(recorder.pending()).toBe(0);
  });

  it("recreates over the same durable store and flushes its pending record", async () => {
    const store = memoryStore();
    const first = createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => "11111111-1111-4111-8111-111111111111",
    });
    first.begin(draft);
    first.complete(completion);
    const recordTrade = vi.fn().mockResolvedValue({});
    const recreated = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
    });

    expect(recreated.pending()).toBe(1);
    await recreated.flush();

    expect(recordTrade).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      "AliceWallet",
    );
    expect(recreated.pending()).toBe(0);
  });

  it("keeps a same-session fallback when storage get, set, and remove throw", async () => {
    const store = throwingStore();
    const first = createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => "11111111-1111-4111-8111-111111111111",
    });

    expect(first.pending()).toBe(0);
    await expect(first.flush()).resolves.toBeUndefined();

    first.begin(draft);

    expect(() => first.complete(completion)).not.toThrow();
    expect(first.pending()).toBe(1);

    const recordTrade = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({});
    const recreated = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
    });
    expect(recreated.pending()).toBe(1);

    await expect(recreated.flush()).resolves.toBeUndefined();
    expect(recreated.pending()).toBe(1);
    await expect(recreated.flush()).resolves.toBeUndefined();
    expect(recordTrade).toHaveBeenCalledTimes(2);
    expect(recreated.pending()).toBe(0);
  });

  it("removes only successful records and retries the remaining queue in order", async () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const recordTrade = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store: memoryStore(),
      newId: () => ids.shift()!,
    });
    for (const exitPrice of [151, 152, 153]) {
      recorder.begin(draft);
      recorder.complete({ ...completion, exitPrice });
    }

    await recorder.flush();
    expect(recordTrade.mock.calls.map(([record]) => record.id)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(recorder.pending()).toBe(2);

    await recorder.flush();
    expect(recordTrade.mock.calls.map(([record]) => record.id)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(recorder.pending()).toBe(0);
  });

  it("shares one in-flight flush across concurrent callers", async () => {
    let resolveUpload!: () => void;
    const upload = new Promise<void>((resolve) => { resolveUpload = resolve; });
    const recordTrade = vi.fn().mockReturnValue(upload);
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store: memoryStore(),
      newId: () => "11111111-1111-4111-8111-111111111111",
    });
    recorder.begin(draft);
    recorder.complete(completion);

    const first = recorder.flush();
    const second = recorder.flush();

    expect(second).toBe(first);
    expect(recordTrade).toHaveBeenCalledTimes(1);

    resolveUpload();
    await Promise.all([first, second]);
    expect(recorder.pending()).toBe(0);
  });
});
