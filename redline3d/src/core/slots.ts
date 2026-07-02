/** Slot Machine "Triple 7s": every round you finish (not liquidated) pulls the arm. */
export const JACKPOT_CHANCE = 0.02; // 1-in-50 rounds
export const JACKPOT_COINS = 777;   // the prize IS the theme

/** roll the jackpot from a uniform r∈[0,1): coins won (777 or 0). Coins are the soft
 * off-chain economy, so plain client RNG is fine here — the real-SOL jackpot variant
 * waits for MagicBlock VRF (provable randomness), which crates adopt first. */
export const jackpotRoll = (r: number): number => (r < JACKPOT_CHANCE ? JACKPOT_COINS : 0);
