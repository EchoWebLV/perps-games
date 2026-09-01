import type { SettleReason } from "@perps/engine";
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
  /**
   * Telemetry sink for a round the sweep could not settle, and for a settle that diverged from the
   * mark it was judged on. `roundId` is null when the whole sweep failed (no round in scope).
   * MUST NOT THROW: this is called inside the sweep loop, so a throwing callback aborts the
   * remaining rounds of that tick (they are retried on the next one, but the tick is cut short).
   */
  onError?: (roundId: string | null, error: unknown) => void;
}

/**
 * Which settle outcomes are TERMINAL — the round is over on the server's own evidence, whatever
 * the player does next. A positive whitelist, exhaustive over SettleReason: `satisfies` turns a
 * future fifth variant into a COMPILE error here, and the runtime lookup fails closed (an
 * unrecognized outcome reads back undefined → not terminal → no close), so an unhandled variant
 * can never trigger a settlement by accident.
 */
const TERMINAL_OUTCOMES = {
  liq: true,
  cap: true,
  time: true,
  cashout: false, // the player-initiated exit — nothing has fired, leave the round open
} as const satisfies Record<SettleReason, boolean>;

function isTerminal(outcome: SettleReason): boolean {
  return TERMINAL_OUTCOMES[outcome] === true;
}

/**
 * Autonomous cash settler (closes the free-option hole round-settler-guard documents):
 * every tick, mark() each open round with the SERVER feed and force-close any round whose
 * outcome is terminal (liq / cap / time).
 *
 * mark() primes the shown-mark cache (rounds.ts `lastMark`), so the close settles at the mark
 * just evaluated ONLY while that mark is still fresh — rounds.ts MARK_FRESH_MS is 2500ms. A sweep
 * whose close lands later than that falls back to a fresh feed read and settles at a different
 * price than the one it judged. The cache is per-`makeRounds`-instance and in-process, so the
 * settler must share the SAME instance as the routes or every close takes that fallback path.
 *
 * Client closes race safely: rounds.close takes the per-user advisory lock
 * (`pg_advisory_xact_lock`) and replays the stored result for an already-settled round, so a
 * double close pays out once.
 *
 * KNOWN GAP (mark/close non-atomicity): mark() and close() are two separate transactions. A client
 * action landing in between, or a close delayed past MARK_FRESH_MS, can settle the round at a
 * different outcome than the terminal one this sweep judged. Nothing mispays — close re-derives the
 * outcome from server-stamped marks under the lock — but the settler's decision and the settlement
 * can disagree. This file only OBSERVES that (a `settled_as_cashout_after_terminal_mark` signal to
 * onError). The real fix is an atomic terminal-close in rounds.ts (`closeIfTerminal`: re-mark and
 * settle inside the one advisory-locked transaction), which is not built yet.
 *
 * A "cashout" outcome means the round is still healthy — it stays open for the player. A stale mark
 * (feed down) yields no outcome and never closes: a halted feed must not settle anyone.
 */
export function makeRoundSettler(opts: RoundSettlerOpts): RoundSettler & { tick(): Promise<void> } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function tick(): Promise<void> {
    // A slow sweep can still be in flight when the interval fires again; skip rather than run
    // overlapping sweeps over the same rows (mirrors makeWithdrawConfirmLoop). The reset MUST stay
    // in `finally` — leaving it on the success path only would wedge the settler permanently on the
    // first listOpen failure.
    if (running) return;
    running = true;
    try {
      let open: Array<{ id: string; userId: string }>;
      try {
        open = await opts.listOpen();
      } catch (e) {
        opts.onError?.(null, e); // db hiccup: nothing swept this tick, retry on the next one
        return;
      }
      for (const r of open) {
        try {
          const m = await opts.rounds.mark(r.userId, r.id);
          if (m.status !== "open") continue; // already settled (client got there first)
          if (m.stale) continue; // feed halted — freeze, never settle on a bogus mark
          if (m.outcome === null) continue; // no outcome to judge
          if (!isTerminal(m.outcome)) continue; // healthy — the round stays open for the player
          const settled = await opts.rounds.close(r.userId, r.id, "expire"); // reason is telemetry; outcome is server-derived
          if (settled?.outcome === "cashout") {
            // The close re-derived a non-terminal outcome from a different mark than the one judged
            // above (see KNOWN GAP). The payout is still correct; surface the divergence.
            opts.onError?.(
              r.id,
              new Error(`settled_as_cashout_after_terminal_mark: marked "${m.outcome}" but settled "cashout"`),
            );
          }
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
      if (timer) return; // idempotent — a double start must not leak an unstoppable interval
      void tick().catch(() => {});
      timer = setInterval(() => void tick().catch(() => {}), opts.pollMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
