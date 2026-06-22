// Per-tick settlement faithful to packages/engine/src/settle.ts.
//
// We import equityOf + payoutOf DIRECTLY from the engine so the money math is
// provably identical. We replicate ONLY:
//   (1) the precedence at each evaluated mark: liq -> cap -> time -> cashout
//   (2) finalize's outcome->equity mapping: liq=0, cap=CAP, cashout=equityOf(pos,price)
//   (3) payout = floor(payoutOf(stake, equity, EDGE))
//
// DIFFERENCE FROM PRODUCTION (intentional, documented): production settle.ts only
// evaluates terminal conditions at the server-stamped MARKS (open, each action, exit).
// The planned autonomous settler will evaluate EVERY tick. We model per-tick here:
// the conservative / realistic-production target. Marks-only would be even more
// house-favorable (fewer liq/cap triggers, players' voluntary cashouts dominate).
//
// Players here take NO mid-round actions (no flip/lever), so banked stays 0 and the
// only thing that changes between ticks is the price mark. Voluntary cashout policy
// is applied by the caller examining live equity each tick.
import { equityOf, payoutOf } from "../packages/engine/src/economics.ts";
import type { Position, SettleReason, Dir } from "../packages/engine/src/types.ts";
import type { RoundConfig } from "../packages/engine/src/config.ts";

export interface SimResult {
  outcome: SettleReason;
  equity: number;
  payoutCoins: number;
  pnlCoins: number;
}

function finalize(outcome: SettleReason, pos: Position, price: number, stake: number, cfg: RoundConfig): SimResult {
  const equity = outcome === "liq" ? 0 : outcome === "cap" ? cfg.CAP : equityOf(pos, price);
  const payoutCoins = Math.floor(payoutOf(stake, equity, cfg.EDGE));
  return { outcome, equity, payoutCoins, pnlCoins: payoutCoins - stake };
}

export interface RoundSpec {
  dir: Dir;
  lev: number;
  stake: number;
  entryIdx: number;       // tick index of open
  /** voluntary cashout policy, evaluated on live equity each tick AFTER barrier checks */
  policy:
    | { kind: "ride" }                         // never voluntarily exit; ride to a barrier or time
    | { kind: "target"; targetEquity: number } // cash out when equity >= target
    | { kind: "scared"; targetEquity: number; maxTicks: number }; // small profit OR bail after N ticks
}

/**
 * Walk the price path tick-by-tick from entryIdx. At each tick evaluate the SAME
 * precedence as the engine (liq -> cap -> time), then the player's voluntary policy.
 * Returns the settlement. cfg.MAXSEC is in seconds == ticks (1s ticks).
 */
export function settlePerTick(prices: number[], spec: RoundSpec, cfg: RoundConfig): SimResult {
  const entryRaw = prices[spec.entryIdx];
  const pos: Position = { dir: spec.dir, lev: spec.lev, entryRaw, banked: 0 };

  const maxTick = spec.entryIdx + cfg.MAXSEC; // time barrier (>= MAXSEC seconds elapsed)
  for (let i = spec.entryIdx; i < prices.length; i++) {
    const price = prices[i];
    const eq = equityOf(pos, price);
    // engine precedence
    if (eq <= cfg.LIQ) return finalize("liq", pos, price, spec.stake, cfg);
    if (eq >= cfg.CAP) return finalize("cap", pos, price, spec.stake, cfg);
    const elapsed = i - spec.entryIdx;
    if (elapsed >= cfg.MAXSEC) return finalize("time", pos, price, spec.stake, cfg);
    // voluntary cashout (only counts as a real exit if equity barrier not already hit)
    if (i > spec.entryIdx) {
      const p = spec.policy;
      if (p.kind === "target" && eq >= p.targetEquity) return finalize("cashout", pos, price, spec.stake, cfg);
      if (p.kind === "scared" && (eq >= p.targetEquity || elapsed >= p.maxTicks)) return finalize("cashout", pos, price, spec.stake, cfg);
    }
  }
  // ran off the end of the path before any barrier (only if path shorter than MAXSEC):
  // settle at last price as a cashout. Paths are built long enough that this is rare.
  const last = prices.length - 1;
  return finalize("cashout", pos, prices[last], spec.stake, cfg);
}
