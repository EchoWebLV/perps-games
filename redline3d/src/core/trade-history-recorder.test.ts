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
