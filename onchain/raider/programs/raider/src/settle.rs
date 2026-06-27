// settle.rs — fixed-point port of packages/engine/src/economics.ts (no actions: banked = 0).
//
// PROVABLE-FAIRNESS CORE. Pure integer math, NO f64. Anyone holding the on-chain
// round data (dir, lev, stake, entry_raw) plus the exit mark can recompute the exact
// payout this module produces. All rounding is house-favorable (truncating integer
// division floors the payout), matching the off-chain engine's `Math.floor`.
//
// Parity with packages/engine:
//   economics.ts  equityOf = 1 + banked + dir*lev*(price/entryRaw - 1), clamped >= 0
//                 payoutOf = stake * max(0, equity) * (1 - edge)         [floored here]
//   config.ts     EDGE 0.05, LIQ 0.2, CAP 25, RMIN 10, RMAX (Phase 1 = 2000 per spec)
// Phase 1 has no mid-round actions, so banked = 0.

pub const SCALE: i128 = 1_000_000;
pub const EDGE_FP: i128 = 50_000; // 0.05
pub const LIQ_FP: i128 = 200_000; // 0.20
pub const CAP_FP: i128 = 25_000_000; // 25.0
pub const RMIN: u32 = 10;
pub const RMAX: u32 = 2000;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Outcome {
    Cashout,
    Cap,
    Liq,
}

impl Outcome {
    /// Stable wire code stored in `Round.outcome`: 0 cashout / 1 cap / 2 liq.
    pub fn code(self) -> u8 {
        match self {
            Outcome::Cashout => 0,
            Outcome::Cap => 1,
            Outcome::Liq => 2,
        }
    }
}

/// equity_fp = SCALE + dir*lev*(exit/entry - 1), clamped >= 0. Same feed => expo cancels.
pub fn equity_fp(dir: i8, lev: u32, entry_raw: i64, exit_raw: i64) -> i128 {
    let ratio = (exit_raw as i128) * SCALE / (entry_raw as i128);
    let eq = SCALE + (dir as i128) * (lev as i128) * (ratio - SCALE);
    if eq < 0 {
        0
    } else {
        eq
    }
}

/// Apply terminal precedence at the exit mark; return (outcome, settled_equity_fp).
pub fn terminal(eq: i128) -> (Outcome, i128) {
    if eq <= LIQ_FP {
        (Outcome::Liq, 0)
    } else if eq >= CAP_FP {
        (Outcome::Cap, CAP_FP)
    } else {
        (Outcome::Cashout, eq)
    }
}

/// payout = floor(stake * equity * (1 - edge)); u128 intermediates (overflow-safe to
/// well beyond a 50 USDC stake at CAP: 50e6 * 25e6 * 950_000 ≈ 1.19e21 << u128 max ~3.4e38).
pub fn payout(stake: u64, settled_eq_fp: i128) -> u64 {
    let p = (stake as u128) * (settled_eq_fp as u128) * ((SCALE - EDGE_FP) as u128)
        / (SCALE as u128)
        / (SCALE as u128);
    p as u64
}

/// Max a round can ever pay (equity capped at CAP): the house pre-lock at open.
pub fn max_payout(stake: u64) -> u64 {
    payout(stake, CAP_FP)
}

/// Full settle for one mark.
pub fn settle(dir: i8, lev: u32, stake: u64, entry_raw: i64, exit_raw: i64) -> (Outcome, u64) {
    let (o, eq) = terminal(equity_fp(dir, lev, entry_raw, exit_raw));
    (o, payout(stake, eq))
}

#[cfg(test)]
mod tests {
    use super::*;

    // long, 100x, entry 60000, exit 60600 (+1%): ratio = 60600*1e6/60000 = 1_010_000;
    // equity = 1e6 + 1*100*(1_010_000-1e6) = 1e6 + 100*10_000 = 2_000_000 (= 2.0x).
    #[test]
    fn long_winner() {
        let (o, p) = settle(1, 100, 1_000_000, 60_000, 60_600);
        assert_eq!(o, Outcome::Cashout);
        // payout = floor(1_000_000 * 2_000_000 * 950_000 / 1e12) = 1_900_000.
        assert_eq!(p, 1_900_000);
    }

    // long, 1000x, exit -0.1% => ratio = 59940*1e6/60000 = 999_000;
    // equity = 1e6 + 1000*(999_000-1e6) = 1e6 + 1000*(-1000) = 0 => 0 <= LIQ_FP => Liq.
    #[test]
    fn long_liquidated() {
        let (o, p) = settle(1, 1000, 1_000_000, 60_000, 59_940);
        assert_eq!(o, Outcome::Liq);
        assert_eq!(p, 0);
    }

    // short, 50x, exit -2% => ratio = 58800*1e6/60000 = 980_000;
    // equity = 1e6 + (-1)*50*(980_000-1e6) = 1e6 + (-50)*(-20_000) = 2_000_000 (= 2.0x).
    #[test]
    fn short_winner() {
        let (o, _) = settle(-1, 50, 1_000_000, 60_000, 58_800);
        assert_eq!(o, Outcome::Cashout);
    }

    // cap clamp: long, 2000x, exit +1.5% => ratio = 60900*1e6/60000 = 1_015_000;
    // raw equity = 1e6 + 2000*(1_015_000-1e6) = 1e6 + 2000*15_000 = 31_000_000 (= 31x) >= CAP
    // => Cap, equity settles at CAP_FP, payout = max_payout(stake).
    #[test]
    fn cap_clamp() {
        let (o, p) = settle(1, 2000, 1_000_000, 60_000, 60_900);
        assert_eq!(o, Outcome::Cap);
        assert_eq!(p, max_payout(1_000_000)); // 23_750_000
    }

    // House pre-lock invariant: max_payout = stake * CAP * (1 - EDGE) = stake * 25 * 0.95
    // = stake * 23.75. For stake 1_000_000 => floor(1e6 * 25e6 * 950_000 / 1e12) = 23_750_000.
    #[test]
    fn max_payout_is_23_75x() {
        assert_eq!(max_payout(1_000_000), 23_750_000);
    }
}
