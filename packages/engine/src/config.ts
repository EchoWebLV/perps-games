// Mutable at runtime: the garage upgrade tree tunes LIQ / MAXSEC / RMAX from their
// base values (read live by round.ts, main.ts, and leverage.ts).
export const CONFIG = {
  EDGE: 0.05,      // house edge baked into payout
  LIQ: 0.2,        // equity <= LIQ → liquidated (Suspension lowers this)
  CAP: 25,         // equity >= CAP → max-payout settle
  MAXSEC: 60,      // time cap (seconds) (Long-Range Tank raises this)
  RMIN: 10,        // min leverage
  RMAX: 1000,      // max leverage (Turbo Kit raises this)
  REDLINE: 400,    // redline leverage threshold
  START_BALANCE: 100,
  MIN_STAKE: 1,
  MAX_STAKE: 50,
};

/**
 * Immutable per-round config shape. The SERVER snapshots a RoundConfig into each
 * round row at open time and settles from that snapshot — it never reads the mutable
 * CONFIG global (where one user's garage upgrades would otherwise bleed into everyone).
 */
export interface RoundConfig {
  EDGE: number;   // house edge baked into payout
  LIQ: number;    // equity <= LIQ → liquidated
  CAP: number;    // equity >= CAP → max-payout settle
  MAXSEC: number; // time cap (seconds)
  RMIN: number;   // min leverage
  RMAX: number;   // max leverage
}

/** Server base config (mirrors CONFIG's base values). 1.2 settles every round on this. */
export const BASE_CONFIG: RoundConfig = {
  EDGE: 0.05,
  LIQ: 0.2,
  CAP: 25,
  MAXSEC: 60,
  RMIN: 10,
  RMAX: 1000,
};
