import { describe, expect, it, vi } from "vitest";
import { ensureStakeBalance } from "./stake-wallet";

describe("ensureStakeBalance", () => {
  it("does nothing when the playable balance already covers the stake", async () => {
    const deposit = vi.fn();
    const pollBalance = vi.fn();

    const balance = await ensureStakeBalance({
      currentBalance: 150,
      stake: 100,
      deposit,
      pollBalance,
      delay: async () => {},
    });

    expect(balance).toBe(150);
    expect(deposit).not.toHaveBeenCalled();
    expect(pollBalance).not.toHaveBeenCalled();
  });

  it("stakes the missing amount from the wallet and waits until the playable balance covers the stake", async () => {
    const deposit = vi.fn(async () => {});
    const pollBalance = vi.fn(async () => 100);

    const balance = await ensureStakeBalance({
      currentBalance: 25,
      stake: 100,
      deposit,
      pollBalance,
      maxPolls: 1,
      delay: async () => {},
    });

    expect(deposit).toHaveBeenCalledWith(75);
    expect(pollBalance).toHaveBeenCalledOnce();
    expect(balance).toBe(100);
  });
});
