// settle.rs — fixed-point port of packages/engine/src/economics.ts.
//
// PROVABLE-FAIRNESS CORE. Pure integer math, NO f64. Anyone holding the on-chain
// round data (dir, lev, stake, entry_raw, banked) plus the exit mark can recompute
// the exact payout this module produces. All rounding is house-favorable (truncating
// integer division floors the payout), matching the off-chain engine's `Math.floor`.
//
// Parity with packages/engine:
//   economics.ts  equityOf = 1 + banked + dir*lev*(price/entryRaw - 1), clamped >= 0
//                 payoutOf = stake * max(0, equity) * (1 - edge)         [floored here]
//   config.ts     EDGE 0.05, LIQ 0.2, CAP 25, RMIN 10, RMAX 3000 (car+nitro peak: 1500 base × 2×)
// banked is threaded as i128 (fixed-point, SCALE=1e6). Phase 1 passes 0.

pub const SCALE: i128 = 1_000_000;
pub const EDGE_FP: i128 = 50_000; // 0.05
// Liquidation-floor bounds (SCALE units). The DEFAULT/worst floor is 0.20; the
// Suspension upgrade lowers a round's floor toward MIN_LIQ_FP (0.10), letting a
// position survive a deeper drawdown before wipeout. `open` clamps the client-
// requested floor into [MIN_LIQ_FP, LIQ_FP] and stamps it on the round; every settle
// path reads the round's OWN `liq_fp` (never this const directly), so the threshold is
// fixed and provably recomputable for the life of the round.
pub const LIQ_FP: i128 = 200_000; // 0.20 — default + max (highest/worst floor)
pub const MIN_LIQ_FP: i128 = 100_000; // 0.10 — Suspension-maxed (lowest/best floor)
pub const CAP_FP: i128 = 25_000_000; // 25.0
pub const RMIN: u32 = 10;
pub const RMAX: u32 = 3000;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Outcome {
    Cashout,
    Cap,
    Liq,
    Time,
}

impl Outcome {
    /// Stable wire code stored in `Round.outcome`: 0 cashout / 1 cap / 2 liq / 3 time.
    pub fn code(self) -> u8 {
        match self {
            Outcome::Cashout => 0,
            Outcome::Cap => 1,
            Outcome::Liq => 2,
            Outcome::Time => 3,
        }
    }
}

/// Realize the current segment into banked: banked + dir*lev*(price/entry - 1).
/// Integer port of packages/engine economics.ts `rebank`. Signed (can go negative).
pub fn rebank_fp(banked_fp: i128, dir: i8, lev: u32, entry_raw: i64, price_raw: i64) -> i128 {
    let ratio = (price_raw as i128) * SCALE / (entry_raw as i128);
    banked_fp + (dir as i128) * (lev as i128) * (ratio - SCALE)
}

/// equity_fp = SCALE + banked + dir*lev*(exit/entry - 1), clamped >= 0.
/// Integer port of economics.ts `equityOf`. Same feed => the expo cancels in `ratio`.
pub fn equity_fp(banked_fp: i128, dir: i8, lev: u32, entry_raw: i64, exit_raw: i64) -> i128 {
    let eq = SCALE + rebank_fp(banked_fp, dir, lev, entry_raw, exit_raw);
    if eq < 0 {
        0
    } else {
        eq
    }
}

/// Apply terminal precedence at the exit mark; return (outcome, settled_equity_fp).
/// `liq_fp` is the round's per-round liquidation floor (SCALE units): equity at or
/// below it liquidates. Callers pass `round.liq_fp`; the default is LIQ_FP (0.20).
pub fn terminal(eq: i128, liq_fp: i128) -> (Outcome, i128) {
    if eq <= liq_fp {
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

/// Full settle for one mark (liq/cap/cashout precedence; time is layered by the
/// caller, which has `now`/`deadline_ts`).
pub fn settle(
    banked_fp: i128,
    dir: i8,
    lev: u32,
    stake: u64,
    entry_raw: i64,
    exit_raw: i64,
    liq_fp: i128,
) -> (Outcome, u64) {
    let (o, eq) = terminal(equity_fp(banked_fp, dir, lev, entry_raw, exit_raw), liq_fp);
    (o, payout(stake, eq))
}

/// True iff a terminal fires at this mark: liq/cap by equity, OR the 60s time-cap
/// by the clock. The keeper/crank calls `tick`, which settles only when this is true.
pub fn fires(
    banked_fp: i128,
    dir: i8,
    lev: u32,
    entry_raw: i64,
    exit_raw: i64,
    now: i64,
    deadline_ts: i64,
    liq_fp: i128,
) -> bool {
    let (term, _) = terminal(equity_fp(banked_fp, dir, lev, entry_raw, exit_raw), liq_fp);
    term != Outcome::Cashout || now >= deadline_ts
}

#[cfg(test)]
mod tests {
    use super::*;

    // banked = 0 path (Phase-1 parity): long, 100x, +1% => equity 2.0x, cashout.
    #[test]
    fn long_winner_no_bank() {
        let (o, p) = settle(0, 1, 100, 1_000_000, 60_000, 60_600, LIQ_FP);
        assert_eq!(o, Outcome::Cashout);
        assert_eq!(p, 1_900_000); // floor(1e6 * 2e6 * 950_000 / 1e12)
    }

    // banked = 0: long, 1000x, -0.1% => equity 0 <= LIQ => Liq, payout 0.
    #[test]
    fn long_liquidated_no_bank() {
        let (o, p) = settle(0, 1, 1000, 1_000_000, 60_000, 59_940, LIQ_FP);
        assert_eq!(o, Outcome::Liq);
        assert_eq!(p, 0);
    }

    // cap clamp: long, 2000x, +1.5% => raw equity 31x >= CAP => Cap, payout = max_payout.
    #[test]
    fn cap_clamp_no_bank() {
        let (o, p) = settle(0, 1, 2000, 1_000_000, 60_000, 60_900, LIQ_FP);
        assert_eq!(o, Outcome::Cap);
        assert_eq!(p, max_payout(1_000_000)); // 23_750_000
    }

    #[test]
    fn max_payout_is_23_75x() {
        assert_eq!(max_payout(1_000_000), 23_750_000);
    }

    // rebank: long 10x, entry 100, price 110 (+10%) => segment = 10*(1_100_000-1e6)
    // = 10*100_000 = 1_000_000; banked 0 -> 1_000_000 (i.e. +1.0 realized).
    #[test]
    fn rebank_realizes_segment() {
        let b = rebank_fp(0, 1, 10, 100, 110);
        assert_eq!(b, 1_000_000);
    }

    // equity carries banked: with banked = 1_000_000 (+1.0), a flat new segment
    // (price == entry) => equity = SCALE + banked + 0 = 2_000_000 (= 2.0x).
    #[test]
    fn equity_includes_banked() {
        let eq = equity_fp(1_000_000, 1, 10, 110, 110);
        assert_eq!(eq, 2_000_000);
    }

    // Mirror packages/engine settle.test.ts "flip" vector with integer math:
    // open long 10x entry 100; flip to short at 110; exit 105.
    //   banked after flip = 0 + 10*(1_100_000-1e6) = 1_000_000
    //   exit segment (dir -1, lev 10, entry 110, exit 105):
    //     ratio = 105*1e6/110 = 954_545; -10*(954_545-1e6) = -10*(-45_455)=454_550
    //   equity = 1e6 + 1_000_000 + 454_550 = 2_454_550 => cashout.
    #[test]
    fn flip_sequence_matches_engine() {
        let banked = rebank_fp(0, 1, 10, 100, 110);
        let eq = equity_fp(banked, -1, 10, 110, 105);
        let (o, _) = terminal(eq, LIQ_FP);
        assert_eq!(o, Outcome::Cashout);
        assert_eq!(eq, 2_454_550);
    }

    // fires(): liq, cap, time(now>=deadline), and the heartbeat no-op (false).
    #[test]
    fn fires_predicate() {
        // adverse 2000x => liq => fires
        assert!(fires(0, 1, 2000, 60_000, 59_970, 100, 1_000_000, LIQ_FP));
        // cap equity (2000x, +1.5%) => terminal Cap => fires
        assert!(fires(0, 1, 2000, 60_000, 60_900, 100, 1_000_000, LIQ_FP));
        // favorable small move, before deadline => no terminal => heartbeat (false)
        assert!(!fires(0, 1, 100, 60_000, 60_060, 100, 1_000_000, LIQ_FP));
        // same benign price but now >= deadline => time => fires
        assert!(fires(0, 1, 100, 60_000, 60_060, 1_000_000, 1_000_000, LIQ_FP));
    }

    // Per-round floor: an equity of 0.15 (150_000) LIQUIDATES at the default 0.20 floor
    // but SURVIVES (cashes out) at the Suspension-maxed 0.10 floor. This is the whole
    // point of the upgrade — a lower floor lets a position ride a deeper drawdown.
    #[test]
    fn lower_floor_survives_deeper_drawdown() {
        let eq = 150_000; // 0.15x equity
        assert_eq!(terminal(eq, LIQ_FP).0, Outcome::Liq); // 0.20 floor: wiped
        assert_eq!(terminal(eq, MIN_LIQ_FP), (Outcome::Cashout, 150_000)); // 0.10 floor: survives
    }

    // settle() end-to-end honoring the per-round floor. long 1000x, entry 60_000, exit
    // 59_949 => ratio 999_150, segment 1000*(999_150-1e6) = -850_000, equity 150_000 (0.15x):
    // Liq (payout 0) at the 0.20 floor; Cashout (payout 142_500) at the 0.10 floor.
    #[test]
    fn settle_honors_per_round_floor() {
        let (o_hi, p_hi) = settle(0, 1, 1000, 1_000_000, 60_000, 59_949, LIQ_FP);
        assert_eq!(o_hi, Outcome::Liq);
        assert_eq!(p_hi, 0);
        let (o_lo, p_lo) = settle(0, 1, 1000, 1_000_000, 60_000, 59_949, MIN_LIQ_FP);
        assert_eq!(o_lo, Outcome::Cashout);
        assert_eq!(p_lo, 142_500); // floor(1e6 * 150_000 * 950_000 / 1e12)
    }

    // fires() honors the per-round floor too: the same 0.15x-equity mark fires a terminal
    // (liq) at the 0.20 floor but is a benign heartbeat (before deadline) at the 0.10 floor.
    #[test]
    fn fires_honors_per_round_floor() {
        assert!(fires(0, 1, 1000, 60_000, 59_949, 100, 1_000_000, LIQ_FP)); // liq at 0.20
        assert!(!fires(0, 1, 1000, 60_000, 59_949, 100, 1_000_000, MIN_LIQ_FP)); // survives at 0.10
    }
}
