import { describe, expect, it, vi } from "vitest";
import { makeRoundSettler } from "./round-settler.js";

type MarkResult = Awaited<ReturnType<import("./rounds.js").Rounds["mark"]>>;
type CloseResult = Awaited<ReturnType<import("./rounds.js").Rounds["close"]>>;

/** a close() return shaped like the real SettleResult & { round } — only `outcome` is read here */
function settled(outcome: "cashout" | "liq" | "cap" | "time"): CloseResult {
  return { outcome, equity: 0, payoutCoins: 0, pnlCoins: 0, round: {} } as unknown as CloseResult;
}

function fixtures() {
  const closed: Array<{ id: string; userId: string; reason: string }> = [];
  const rounds = {
    mark: async (_u: string, id: string): Promise<MarkResult> => ({
      status: "open",
      stale: false,
      outcome: id === "r-liq" ? "liq" : "cashout",
      equity: 1,
      payoutCoins: 0,
      buffer: 1,
    }),
    close: async (userId: string, id: string, reason: "cashout" | "expire"): Promise<CloseResult> => {
      closed.push({ id, userId, reason });
      return settled("liq");
    },
  };
  const listOpen = async () => [
    { id: "r-liq", userId: "u1" },
    { id: "r-fine", userId: "u2" },
  ];
  return { rounds, listOpen, closed, ids: () => closed.map((c) => c.id) };
}

/** every open round marks with this exact outcome */
function markingAll(outcome: MarkResult["outcome"], over: Partial<MarkResult> = {}) {
  return async (): Promise<MarkResult> => ({
    status: "open",
    stale: false,
    outcome,
    equity: 0,
    payoutCoins: 0,
    buffer: 0,
    ...over,
  });
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
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.closed).toEqual([{ id: "r-liq", userId: "u1", reason: "expire" }]);
  });

  it("closes on every terminal outcome (liq / cap / time)", async () => {
    for (const outcome of ["liq", "cap", "time"] as const) {
      const f = fixtures();
      f.rounds.mark = markingAll(outcome);
      const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
      await s.tick();
      expect(f.ids(), `outcome ${outcome} must settle`).toEqual(["r-liq", "r-fine"]);
    }
  });

  it("never closes on the non-terminal 'cashout' outcome", async () => {
    const f = fixtures();
    f.rounds.mark = markingAll("cashout");
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.ids()).toEqual([]);
  });

  // --- guard isolation: each of these must fail if ITS OWN guard alone is deleted -------------

  it("a stale mark never triggers a close, even when it carries a terminal outcome", async () => {
    const f = fixtures();
    f.rounds.mark = markingAll("liq", { stale: true }); // terminal outcome — only `stale` holds it back
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.ids()).toEqual([]);
  });

  it("a null outcome on a fresh mark never triggers a close", async () => {
    const f = fixtures();
    f.rounds.mark = markingAll(null, { stale: false }); // fresh — only the null check holds it back
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.ids()).toEqual([]);
  });

  it("an already-settled round is never re-closed, even on a terminal outcome", async () => {
    const f = fixtures();
    f.rounds.mark = markingAll("liq", { status: "settled" }); // only the status check holds it back
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000 });
    await s.tick();
    expect(f.ids()).toEqual([]);
  });

  // --- error isolation -------------------------------------------------------------------------

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
    f.rounds.mark = markingAll("liq");
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

  it("a listOpen failure does not throw out of tick and reports a null roundId", async () => {
    const f = fixtures();
    const onError = vi.fn();
    const s = makeRoundSettler({
      rounds: f.rounds as never,
      listOpen: async () => {
        throw new Error("db down");
      },
      pollMs: 60_000,
      onError,
    });
    await expect(s.tick()).resolves.toBeUndefined();
    expect(f.ids()).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeNull(); // whole-sweep failure: no round in scope
    expect((onError.mock.calls[0]?.[1] as Error).message).toBe("db down");
  });

  it("recovers on the next tick after a listOpen failure (the in-flight flag is always reset)", async () => {
    const f = fixtures();
    f.rounds.mark = markingAll("liq");
    let calls = 0;
    const s = makeRoundSettler({
      rounds: f.rounds as never,
      listOpen: async () => {
        calls += 1;
        if (calls === 1) throw new Error("db down");
        return [{ id: "r1", userId: "u1" }];
      },
      pollMs: 60_000,
    });
    await s.tick(); // fails
    await s.tick(); // must still sweep — a wedged in-flight flag would silently skip forever
    expect(f.ids()).toEqual(["r1"]);
  });

  // --- close/mark divergence signal (KNOWN GAP observability) -----------------------------------

  it("signals onError when a terminal mark settles as 'cashout'", async () => {
    const f = fixtures();
    f.rounds.mark = markingAll("liq");
    f.rounds.close = async (userId: string, id: string, reason: "cashout" | "expire") => {
      f.closed.push({ id, userId, reason });
      return settled("cashout"); // the close re-derived a different outcome
    };
    const onError = vi.fn();
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000, onError });
    await s.tick();
    expect(f.ids()).toEqual(["r-liq", "r-fine"]);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toBe("r-liq");
    expect((onError.mock.calls[0]?.[1] as Error).message).toContain("settled_as_cashout_after_terminal_mark");
  });

  it("stays silent when the close agrees with the terminal mark", async () => {
    const f = fixtures();
    f.rounds.mark = markingAll("liq");
    const onError = vi.fn();
    const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 60_000, onError });
    await s.tick();
    expect(f.ids()).toEqual(["r-liq", "r-fine"]);
    expect(onError).not.toHaveBeenCalled();
  });

  // --- loop mechanics ---------------------------------------------------------------------------

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

  it("start() is idempotent: a double start leaves nothing running after one stop", async () => {
    vi.useFakeTimers();
    try {
      const f = fixtures();
      const s = makeRoundSettler({ rounds: f.rounds as never, listOpen: f.listOpen, pollMs: 1000 });
      s.start();
      s.start(); // must not leak a second, unstoppable interval
      await vi.advanceTimersByTimeAsync(1000);
      const afterStart = f.ids().length;
      s.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.ids().length).toBe(afterStart);
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
