import { describe, expect, it, vi } from "vitest";
import { makeRoundSettler } from "./round-settler.js";

type MarkResult = Awaited<ReturnType<import("./rounds.js").Rounds["mark"]>>;

function fixtures() {
  const closed: Array<{ id: string; reason: string }> = [];
  const rounds = {
    mark: async (_u: string, id: string): Promise<MarkResult> => ({
      status: "open",
      stale: false,
      outcome: id === "r-liq" ? "liq" : "cashout",
      equity: 1,
      payoutCoins: 0,
      buffer: 1,
    }),
    close: async (_u: string, id: string, reason: "cashout" | "expire") => {
      closed.push({ id, reason });
      return {} as never;
    },
  };
  const listOpen = async () => [
    { id: "r-liq", userId: "u1" },
    { id: "r-fine", userId: "u2" },
  ];
  return { rounds, listOpen, closed, ids: () => closed.map((c) => c.id) };
}

describe("makeRoundSettler", () => {
  it("closes rounds whose mark outcome is terminal, leaves healthy rounds open", async () => {
    const f = fixtures();
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.ids()).toEqual(["r-liq"]);
  });

  it("closes with reason 'expire' and the round's own owner", async () => {
    const f = fixtures();
    const close = vi.fn(f.rounds.close);
    f.rounds.close = close;
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("u1", "r-liq", "expire");
  });

  it("closes on every terminal outcome (liq / cap / time)", async () => {
    for (const outcome of ["liq", "cap", "time"] as const) {
      const f = fixtures();
      f.rounds.mark = async (): Promise<MarkResult> => ({
        status: "open",
        stale: false,
        outcome,
        equity: 0,
        payoutCoins: 0,
        buffer: 0,
      });
      const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
      await s.tick();
      expect(f.ids(), `outcome ${outcome} must settle`).toEqual(["r-liq", "r-fine"]);
    }
  });

  it("a FeedHalt on one round does not stop the sweep", async () => {
    const f = fixtures();
    f.rounds.mark = async (_u: string, id: string): Promise<MarkResult> => {
      if (id === "r-liq") throw new Error("feed_halt");
      return { status: "open", stale: false, outcome: "liq", equity: 0, payoutCoins: 0, buffer: 0 };
    };
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.ids()).toEqual(["r-fine"]); // r-liq skipped (halted), r-fine's terminal mark closed
  });

  it("a failing close does not stop the sweep and is reported to onError", async () => {
    const f = fixtures();
    f.rounds.mark = async (): Promise<MarkResult> => ({
      status: "open",
      stale: false,
      outcome: "liq",
      equity: 0,
      payoutCoins: 0,
      buffer: 0,
    });
    const inner = f.rounds.close;
    f.rounds.close = async (u: string, id: string, reason: "cashout" | "expire") => {
      if (id === "r-liq") throw new Error("tx conflict");
      return inner(u, id, reason);
    };
    const onError = vi.fn();
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000, onError });
    await expect(s.tick()).resolves.toBeUndefined();
    expect(f.ids()).toEqual(["r-fine"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("r-liq");
    expect((onError.mock.calls[0]?.[1] as Error).message).toBe("tx conflict");
  });

  it("a stale mark never triggers a close", async () => {
    const f = fixtures();
    f.rounds.mark = async (): Promise<MarkResult> => ({
      status: "open",
      stale: true,
      outcome: null,
      equity: 1,
      payoutCoins: 0,
      buffer: 1,
    });
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.ids()).toEqual([]);
  });

  it("an already-settled round is never re-closed", async () => {
    const f = fixtures();
    f.rounds.mark = async (): Promise<MarkResult> => ({
      status: "settled",
      stale: false,
      outcome: "liq",
      equity: 0,
      payoutCoins: 0,
      buffer: 0,
    });
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.ids()).toEqual([]);
  });

  it("a listOpen failure does not throw out of tick", async () => {
    const f = fixtures();
    const s = makeRoundSettler({
      rounds: f.rounds as never,
      listOpen: async () => {
        throw new Error("db down");
      },
      pollMs: 60_000,
    });
    await expect(s.tick()).resolves.toBeUndefined();
    expect(f.ids()).toEqual([]);
  });

  it("skips an overlapping tick while a prior tick is still running", async () => {
    const f = fixtures();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let markCalls = 0;
    f.rounds.mark = async (): Promise<MarkResult> => {
      markCalls += 1;
      await gate;
      return { status: "open", stale: false, outcome: "cashout", equity: 1, payoutCoins: 0, buffer: 1 };
    };
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });

    const first = s.tick();
    await s.tick(); // overlapping — must return immediately without sweeping
    expect(markCalls).toBe(1);
    release();
    await first;
    expect(markCalls).toBe(2); // the first tick swept both rounds
  });

  it("start() sweeps immediately then on every pollMs, stop() halts it", async () => {
    vi.useFakeTimers();
    try {
      const f = fixtures();
      const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 1000 });
      s.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.ids()).toEqual(["r-liq"]); // immediate first sweep
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.ids()).toEqual(["r-liq", "r-liq"]);
      s.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.ids()).toEqual(["r-liq", "r-liq"]); // no further sweeps after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() survives a tick that rejects (loop keeps running)", async () => {
    vi.useFakeTimers();
    try {
      const f = fixtures();
      const s = makeRoundSettler({
        rounds: f.rounds as never,
        listOpen: async () => {
          throw new Error("db down");
        },
        pollMs: 1000,
      });
      s.start();
      await vi.advanceTimersByTimeAsync(3000);
      s.stop();
      expect(f.ids()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
