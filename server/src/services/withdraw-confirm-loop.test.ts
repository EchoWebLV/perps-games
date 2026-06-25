import { describe, expect, it, vi } from "vitest";
import { makeWithdrawConfirmLoop } from "./withdraw-confirm-loop.js";

describe("makeWithdrawConfirmLoop", () => {
  it("confirms every sent id on a tick", async () => {
    const confirm = vi.fn(async () => "confirmed" as const);
    const loop = makeWithdrawConfirmLoop({
      listSentIds: async () => ["a", "b", "c"],
      confirmer: { confirm },
      pollMs: 1000,
    });

    await loop.tick();

    expect(confirm).toHaveBeenCalledTimes(3);
    expect(confirm).toHaveBeenCalledWith("a");
    expect(confirm).toHaveBeenCalledWith("b");
    expect(confirm).toHaveBeenCalledWith("c");
  });

  it("does not throw when one id's confirm rejects (isolates failures)", async () => {
    const confirm = vi.fn(async (id: string) => {
      if (id === "b") throw new Error("rpc down");
      return "confirmed" as const;
    });
    const loop = makeWithdrawConfirmLoop({
      listSentIds: async () => ["a", "b", "c"],
      confirmer: { confirm },
      pollMs: 1000,
    });

    await expect(loop.tick()).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("skips an overlapping tick while a prior tick is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const listSentIds = vi.fn(async () => ["a"]);
    const confirm = vi.fn(async () => {
      await gate; // block the first tick mid-flight
      return "confirmed" as const;
    });
    const loop = makeWithdrawConfirmLoop({ listSentIds, confirmer: { confirm }, pollMs: 1000 });

    const first = loop.tick(); // starts, sets running=true synchronously, then blocks in confirm
    await loop.tick(); // re-entrant call: should no-op immediately
    expect(listSentIds).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(listSentIds).toHaveBeenCalledTimes(1);
  });
});
