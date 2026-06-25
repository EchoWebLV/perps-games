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
});
