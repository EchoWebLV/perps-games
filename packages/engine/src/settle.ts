import type { Dir, Position, SettleReason } from "./types";
import type { RoundConfig } from "./config";
import { equityOf, payoutOf, rebank } from "./economics";

/** A mid-round action, server-stamped with the oracle price + ts at the moment it arrived. */
export type Action =
  | { kind: "flip"; dir: Dir; priceRaw: number; tsUs: number }
  | { kind: "lever"; lev: number; priceRaw: number; tsUs: number }
  // NOTE: "bonus" (pickups) is supported by the engine for forward-compat but is NOT
  // accepted from clients by the 1.2 REST API — server-originated / client-side only.
  | { kind: "bonus"; amount: number; priceRaw: number; tsUs: number };

export interface SettleInput {
  openDir: Dir;
  openLev: number;
  entryRaw: number;       // server-stamped oracle price at open
  entryTsUs: number;      // server-stamped oracle ts at open (µs)
  stake: number;          // integer coins (validated by the caller)
  actions: Action[];      // in application order; each price/ts server-stamped
  exitRaw: number;        // server-stamped oracle price at close
  exitTsUs: number;       // server-stamped oracle ts at close (µs)
  cfg: RoundConfig;       // effective config snapshotted at open
}

export interface SettleResult {
  outcome: SettleReason;
  equity: number;         // float, for audit/telemetry only — NOT stored as money
  payoutCoins: number;    // INTEGER coins to credit back (floored, house-favorable)
  pnlCoins: number;       // payoutCoins - stake (integer; negative on loss)
}

/** apply one mid-round action to the running position (mirrors RoundEngine.set*). */
function applyAction(pos: Position, a: Action): Position {
  switch (a.kind) {
    case "flip":
      return { ...rebank(pos, a.priceRaw), dir: a.dir };
    case "lever":
      return { ...rebank(pos, a.priceRaw), lev: a.lev };
    case "bonus":
      return { ...pos, banked: pos.banked + a.amount };
  }
}

function finalize(outcome: SettleReason, pos: Position, price: number, inp: SettleInput): SettleResult {
  const equity = outcome === "liq" ? 0 : outcome === "cap" ? inp.cfg.CAP : equityOf(pos, price);
  const payoutCoins = Math.floor(payoutOf(inp.stake, equity, inp.cfg.EDGE));
  return { outcome, equity, payoutCoins, pnlCoins: payoutCoins - inp.stake };
}

/**
 * Pure, deterministic settlement. Walks every price the server stamped (each action mark,
 * then the close mark). At each mark, checks terminal conditions in the SAME precedence as
 * RoundEngine.tick (liq → cap → time → cashout). If none trigger, applies the action and
 * continues. Reuses equityOf/payoutOf/rebank verbatim — one source of truth with the client.
 */
export function settleRound(inp: SettleInput): SettleResult {
  const { cfg, entryTsUs } = inp;
  let pos: Position = { dir: inp.openDir, lev: inp.openLev, entryRaw: inp.entryRaw, banked: 0 };

  const terminalAt = (price: number, tsUs: number): SettleReason | null => {
    const eq = equityOf(pos, price);
    if (eq <= cfg.LIQ) return "liq";
    if (eq >= cfg.CAP) return "cap";
    if ((tsUs - entryTsUs) / 1_000_000 >= cfg.MAXSEC) return "time";
    return null;
  };

  for (const a of inp.actions) {
    const t = terminalAt(a.priceRaw, a.tsUs);
    if (t) return finalize(t, pos, a.priceRaw, inp);
    pos = applyAction(pos, a);
  }

  const t = terminalAt(inp.exitRaw, inp.exitTsUs);
  if (t) return finalize(t, pos, inp.exitRaw, inp);
  return finalize("cashout", pos, inp.exitRaw, inp);
}
