import type { Rounds } from "./rounds.js";
import type { RoundSettler } from "./round-settler-guard.js";

export interface RoundSettlerOpts {
  rounds: Pick<Rounds, "mark" | "close">;
  /**
   * Every open round (id + owner). Index-friendly: `where status = 'open'` is covered by the
   * partial index `rounds_one_open_idx` (unique on user_id where status = 'open').
   */
  listOpen: () => Promise<Array<{ id: string; userId: string }>>;
  pollMs: number;
  onError?: (roundId: string, error: unknown) => void;
}

/**
 * Autonomous cash settler (closes the free-option hole round-settler-guard documents):
 * every tick, mark() each open round with the SERVER feed and force-close any round whose
 * outcome is terminal (liq / cap / time). mark() primes the shown-mark cache (rounds.ts
 * `lastMark`), so the close settles at exactly the mark that was just evaluated — the settler
 * must therefore share the SAME `makeRounds` instance as the routes (that cache is per-instance,
 * in-process). Client closes race safely: rounds.close takes the per-user advisory lock
 * (`pg_advisory_xact_lock`) and replays the stored result for an already-settled round, so a
 * double close pays out once.
 *
 * A non-terminal ("cashout") outcome means the round is still healthy — it stays open for the
 * player. A stale mark (feed down) yields no outcome and never closes: a halted feed must not
 * settle anyone.
 */
export function makeRoundSettler(opts: RoundSettlerOpts): RoundSettler & { tick(): Promise<void> } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function tick(): Promise<void> {
    // A slow sweep can still be in flight when the interval fires again; skip rather than run
    // overlapping sweeps over the same rows (mirrors makeWithdrawConfirmLoop).
    if (running) return;
    running = true;
    try {
      let open: Array<{ id: string; userId: string }>;
      try {
        open = await opts.listOpen();
      } catch (e) {
        opts.onError?.("", e); // db hiccup: nothing swept this tick, retry on the next one
        return;
      }
      for (const r of open) {
        try {
          const m = await opts.rounds.mark(r.userId, r.id);
          // already settled / feed halted / still healthy → leave it alone
          if (m.status !== "open" || m.stale || m.outcome === null || m.outcome === "cashout") continue;
          await opts.rounds.close(r.userId, r.id, "expire"); // reason is telemetry; outcome is server-derived
        } catch (e) {
          opts.onError?.(r.id, e); // halt/transient: retry next tick, keep sweeping
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      void tick().catch(() => {});
      timer = setInterval(() => void tick().catch(() => {}), opts.pollMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
