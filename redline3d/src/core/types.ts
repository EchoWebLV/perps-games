export type Dir = 1 | -1;
export type Phase = "idle" | "live" | "settled" | "liquidated";
export type SettleReason = "cashout" | "cap" | "time" | "liq";

export interface Position {
  dir: Dir;
  lev: number;
  /** raw price at the current anchor (re-anchored on leverage change) */
  entryRaw: number;
  /** realized/locked gains from prior segments */
  banked: number;
}

export interface Snapshot {
  phase: Phase;
  equity: number;
  payout: number;
  /** liquidation buffer 0..1 */
  buffer: number;
  banked: number;
  lev: number;
  reason?: SettleReason;
}
