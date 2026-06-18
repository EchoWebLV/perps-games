export const CONFIG = {
  EDGE: 0.05,      // house edge baked into payout
  LIQ: 0.2,        // equity <= LIQ → liquidated
  CAP: 25,         // equity >= CAP → max-payout settle
  MAXSEC: 60,      // time cap (seconds)
  RMIN: 10,        // min leverage
  RMAX: 1000,      // max leverage
  REDLINE: 400,    // redline leverage threshold
  START_BALANCE: 100,
  MIN_STAKE: 1,
  MAX_STAKE: 50,
} as const;
