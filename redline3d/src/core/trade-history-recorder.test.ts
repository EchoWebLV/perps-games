import { describe, expect, it, vi } from "vitest";
import { createTradeHistoryRecorder } from "./trade-history-recorder";

function memoryStore(options: {
  enumerate?: (keys: string[]) => string[];
  failSet?: () => boolean;
  onRemove?: (key: string) => void;
} = {}): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (options.failSet?.()) throw new Error("set_failed");
      values.set(key, value);
    },
    removeItem: (key) => { values.delete(key); options.onRemove?.(key); },
    clear: () => values.clear(),
    key: (index) => (options.enumerate?.([...values.keys()]) ?? [...values.keys()])[index] ?? null,
    get length() { return values.size; },
  };
}

function throwingStore(): Storage {
  return {
    getItem: () => { throw new Error("get_failed"); },
    setItem: () => { throw new Error("set_failed"); },
    removeItem: () => { throw new Error("remove_failed"); },
    clear: () => {},
    key: () => "redline.trade-history.outbox.v1:AliceWallet:existing",
    get length() { return 1; },
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

  it("restarts a drain when append and flush land before latch cleanup", async () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    let recorder!: ReturnType<typeof createTradeHistoryRecorder>;
    let racedFlush: Promise<void> | undefined;
    let scheduleRace = true;
    const store = memoryStore({
      onRemove: () => {
        if (!scheduleRace) return;
        scheduleRace = false;
        queueMicrotask(() => {
          recorder.begin(draft);
          recorder.complete({ ...completion, exitPrice: 152 });
          racedFlush = recorder.flush();
        });
      },
    });
    const recordTrade = vi.fn().mockResolvedValue({});
    recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => ids.shift()!,
    });
    recorder.begin(draft);
    recorder.complete(completion);

    const firstFlush = recorder.flush();
    await firstFlush;

    expect(racedFlush).toBe(firstFlush);
    expect(recordTrade.mock.calls.map(([record]) => record.id)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(recorder.pending()).toBe(0);
  });

  it("keeps cross-tab records collision-free and removes only the uploaded record", async () => {
    const store = memoryStore();
    const aliceId = "22222222-2222-4222-8222-222222222222";
    const bobId = "11111111-1111-4111-8111-111111111111";
    const recordTradeA = vi.fn(async (record: { id: string }) => {
      if (record.id === aliceId) throw new Error("offline");
      return {};
    });

    vi.resetModules();
    const tabAModule = await import("./trade-history-recorder");
    const tabA = tabAModule.createTradeHistoryRecorder({
      api: { recordTrade: recordTradeA } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => aliceId,
      now: () => 1_750_000_000_002,
    });
    expect(tabA.pending()).toBe(0);

    vi.resetModules();
    const tabBModule = await import("./trade-history-recorder");
    const tabB = tabBModule.createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => bobId,
      now: () => 1_750_000_000_001,
    });
    tabB.begin(draft);
    tabB.complete({ ...completion, exitPrice: 152 });

    tabA.begin(draft);
    tabA.complete(completion);

    expect(tabA.pending()).toBe(2);
    expect(tabB.pending()).toBe(2);

    await tabA.flush();
    expect(recordTradeA.mock.calls.map(([record]) => record.id)).toEqual([bobId, aliceId]);
    expect(tabB.pending()).toBe(1);

    vi.resetModules();
    const observerModule = await import("./trade-history-recorder");
    const recordTradeObserver = vi.fn().mockResolvedValue({});
    const observer = observerModule.createTradeHistoryRecorder({
      api: { recordTrade: recordTradeObserver } as any,
      wallet: () => "AliceWallet",
      store,
    });
    expect(observer.pending()).toBe(1);

    await observer.flush();
    expect(recordTradeObserver).toHaveBeenCalledWith(
      expect.objectContaining({ id: aliceId }),
      "AliceWallet",
    );
    expect(observer.pending()).toBe(0);
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

  it("skips a malformed stored entry without hiding a valid record", async () => {
    const store = memoryStore();
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => "11111111-1111-4111-8111-111111111111",
    });
    recorder.begin(draft);
    const validRecord = recorder.complete(completion)!;
    store.setItem(
      "redline.trade-history.outbox.v1:AliceWallet:malformed",
      "{not-json",
    );

    vi.resetModules();
    const recreatedModule = await import("./trade-history-recorder");
    const recordTrade = vi.fn().mockResolvedValue({});
    const recreated = recreatedModule.createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
    });

    expect(recreated.pending()).toBe(1);
    await recreated.flush();
    expect(recordTrade).toHaveBeenCalledWith(validRecord, "AliceWallet");
    expect(recreated.pending()).toBe(0);
  });

  it("skips a parseable incomplete record without breaking pending, complete, or flush", async () => {
    const store = memoryStore();
    const incompleteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    store.setItem(
      `redline.trade-history.outbox.v1:AliceWallet:${incompleteId}`,
      JSON.stringify({ queueOrder: 0, record: { id: incompleteId } }),
    );
    const recordTrade = vi.fn().mockResolvedValue({});
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => "11111111-1111-4111-8111-111111111111",
    });
    let pendingBefore = -1;
    expect(() => { pendingBefore = recorder.pending(); }).not.toThrow();

    recorder.begin(draft);
    let validRecord: ReturnType<typeof recorder.complete> = null;
    expect(() => { validRecord = recorder.complete(completion); }).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();

    expect(pendingBefore).toBe(0);
    expect(recordTrade).toHaveBeenCalledTimes(1);
    expect(recordTrade).toHaveBeenCalledWith(validRecord, "AliceWallet");
    expect(recorder.pending()).toBe(0);
  });

  it("skips non-UTC persisted timestamps without blocking a valid record", async () => {
    const store = memoryStore();
    const invalidRecords = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        openedAt: "2026-07-10",
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        openedAt: "July 10, 2026 10:00:00 UTC",
      },
    ];
    invalidRecords.forEach(({ id, openedAt }, queueOrder) => {
      store.setItem(
        `redline.trade-history.outbox.v1:AliceWallet:${id}`,
        JSON.stringify({ queueOrder, record: { id, ...draft, ...completion, openedAt } }),
      );
    });
    const validId = "11111111-1111-4111-8111-111111111111";
    const recordTrade = vi.fn(async (record: { id: string }) => {
      if (record.id !== validId) throw new Error("invalid_opened_at");
      return {};
    });
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => validId,
    });
    recorder.begin(draft);
    const validRecord = recorder.complete(completion)!;
    let pendingBefore = -1;
    expect(() => { pendingBefore = recorder.pending(); }).not.toThrow();

    await expect(recorder.flush()).resolves.toBeUndefined();

    expect(pendingBefore).toBe(1);
    expect(recordTrade.mock.calls.map(([record]) => record)).toEqual([validRecord]);
    expect(recorder.pending()).toBe(0);
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

  it("persists volatile records after storage recovers while upload remains offline", async () => {
    let failWrites = true;
    const store = memoryStore({ failSet: () => failWrites });
    const recordTrade = vi.fn().mockRejectedValue(new Error("offline"));
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => "11111111-1111-4111-8111-111111111111",
    });
    recorder.begin(draft);
    recorder.complete(completion);
    expect(recorder.pending()).toBe(1);

    failWrites = false;
    await recorder.flush();
    expect(recordTrade).toHaveBeenCalledTimes(1);
    expect(recorder.pending()).toBe(1);

    vi.resetModules();
    const recreatedModule = await import("./trade-history-recorder");
    const recreated = recreatedModule.createTradeHistoryRecorder({
      api: { recordTrade: vi.fn().mockRejectedValue(new Error("offline")) } as any,
      wallet: () => "AliceWallet",
      store,
    });

    expect(recreated.pending()).toBe(1);
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

  it("preserves enqueue order across retries when storage enumerates in reverse", async () => {
    const ids = [
      "33333333-3333-4333-8333-333333333333",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const remainingIds = [...ids];
    const recordTrade = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({});
    const store = memoryStore({ enumerate: (keys) => keys.reverse() });
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => remainingIds.shift()!,
    });
    const records = ids.map((_, index) => {
      recorder.begin(draft);
      return recorder.complete({ ...completion, exitPrice: 151 + index })!;
    });

    vi.resetModules();
    const recreatedModule = await import("./trade-history-recorder");
    const recreated = recreatedModule.createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
    });
    await recreated.flush();
    await recreated.flush();

    expect(recordTrade.mock.calls.map(([record]) => record)).toEqual([
      records[0],
      records[1],
      records[1],
      records[2],
    ]);
    expect(recreated.pending()).toBe(0);
  });

  it("persists unique deterministic orders for simultaneous cross-realm enqueues", async () => {
    const store = memoryStore({ enumerate: (keys) => keys.reverse() });
    const enqueueEpoch = 1_750_000_000_000;
    const realmA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const realmB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const recordAId = "33333333-3333-4333-8333-333333333333";
    const recordBId = "11111111-1111-4111-8111-111111111111";

    vi.resetModules();
    const tabAModule = await import("./trade-history-recorder");
    const tabA = tabAModule.createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => recordAId,
      now: () => enqueueEpoch,
      realmId: realmA,
    });
    tabA.begin(draft);
    const recordA = tabA.complete(completion)!;

    vi.resetModules();
    const tabBModule = await import("./trade-history-recorder");
    const tabB = tabBModule.createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => recordBId,
      now: () => enqueueEpoch,
      realmId: realmB,
    });
    tabB.begin(draft);
    const recordB = tabB.complete({ ...completion, exitPrice: 152 })!;

    const storedA = JSON.parse(store.getItem(`redline.trade-history.outbox.v1:AliceWallet:${recordAId}`)!);
    const storedB = JSON.parse(store.getItem(`redline.trade-history.outbox.v1:AliceWallet:${recordBId}`)!);
    const epochPrefix = String(enqueueEpoch).padStart(16, "0");
    const nextEpochPrefix = String(enqueueEpoch + 1).padStart(16, "0");

    vi.resetModules();
    const observerModule = await import("./trade-history-recorder");
    const recordTrade = vi.fn().mockResolvedValue({});
    const observer = observerModule.createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
    });
    await observer.flush();

    expect(storedA.queueOrder).toBe(`${epochPrefix}:${realmA}:0000000000000000`);
    expect(storedB.queueOrder).toBe(`${nextEpochPrefix}:${realmB}:0000000000000000`);
    expect(storedA.queueOrder).not.toBe(storedB.queueOrder);
    expect(recordTrade.mock.calls.map(([record]) => record)).toEqual([recordA, recordB]);
  });

  it("keeps pending FIFO after a fresh realm observes a rolled-back clock", async () => {
    const store = memoryStore({ enumerate: (keys) => keys.reverse() });
    const oldEpoch = 1_750_000_000_100;
    const oldId = "33333333-3333-4333-8333-333333333333";
    const newId = "11111111-1111-4111-8111-111111111111";

    vi.resetModules();
    const oldModule = await import("./trade-history-recorder");
    const oldRecorder = oldModule.createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => oldId,
      now: () => oldEpoch,
      realmId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    oldRecorder.begin(draft);
    const oldRecord = oldRecorder.complete(completion)!;

    vi.resetModules();
    const freshModule = await import("./trade-history-recorder");
    const recordTrade = vi.fn().mockResolvedValue({});
    const freshRecorder = freshModule.createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => newId,
      now: () => oldEpoch - 100,
      realmId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    freshRecorder.begin(draft);
    const newRecord = freshRecorder.complete({ ...completion, exitPrice: 152 })!;
    const storedNew = JSON.parse(store.getItem(`redline.trade-history.outbox.v1:AliceWallet:${newId}`)!);

    await freshRecorder.flush();

    expect(storedNew.queueOrder.slice(0, 16)).toBe(String(oldEpoch + 1).padStart(16, "0"));
    expect(recordTrade.mock.calls.map(([record]) => record)).toEqual([oldRecord, newRecord]);
  });

  it("skips saturated persisted epochs before allocating the next order", async () => {
    const store = memoryStore();
    const saturatedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const validId = "11111111-1111-4111-8111-111111111111";
    const realmId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const enqueueEpoch = 1_750_000_000_000;
    store.setItem(
      `redline.trade-history.outbox.v1:AliceWallet:${saturatedId}`,
      JSON.stringify({
        queueOrder: `${String(Number.MAX_SAFE_INTEGER).padStart(16, "0")}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:0000000000000000`,
        record: { id: saturatedId, ...draft, ...completion },
      }),
    );
    const recordTrade = vi.fn().mockResolvedValue({});
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store,
      newId: () => validId,
      now: () => enqueueEpoch,
      realmId,
    });

    expect(recorder.pending()).toBe(0);
    recorder.begin(draft);
    const validRecord = recorder.complete(completion)!;
    const storedValid = JSON.parse(
      store.getItem(`redline.trade-history.outbox.v1:AliceWallet:${validId}`)!,
    );

    await recorder.flush();

    expect(storedValid.queueOrder).toBe(
      `${String(enqueueEpoch).padStart(16, "0")}:${realmId}:0000000000000000`,
    );
    expect(recordTrade.mock.calls.map(([record]) => record)).toEqual([validRecord]);
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
