import type { Position } from "./types";

/** LINEAR-from-entry equity (vol-independent). entryRaw is the raw price anchor. */
export function equityOf(pos: Position, price: number): number {
  if (!(pos.entryRaw > 0)) return 1;
  const eq = 1 + pos.banked + pos.dir * pos.lev * (price / pos.entryRaw - 1);
  return eq < 0 ? 0 : eq;
}

export function payoutOf(stake: number, equity: number, edge: number): number {
  return stake * Math.max(0, equity) * (1 - edge);
}

export function profitOf(stake: number, payout: number): number {
  return payout - stake;
}

/** price at which equity hits the liq threshold (for the chart line) */
export function liqPriceOf(entryPx: number, dir: number, lev: number, liq: number): number {
  return entryPx * (1 - dir * (1 - liq) / lev);
}

/** liquidation buffer: 1 at/above entry, 0 at LIQ */
export function bufferOf(equity: number, liq: number): number {
  if (equity >= 1) return 1;
  return Math.max(0, (equity - liq) / (1 - liq));
}

/** realize the current segment into banked and re-anchor entry to the current price */
export function rebank(pos: Position, price: number): Position {
  if (!(pos.entryRaw > 0)) return pos;
  return {
    ...pos,
    banked: pos.banked + pos.dir * pos.lev * (price / pos.entryRaw - 1),
    entryRaw: price,
  };
}
