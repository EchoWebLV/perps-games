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
// Fallback ceiling (base units) for the per-session house slice (FIX 2): the largest
// per-round stake the bounded-by-construction default assumes. `max_payout(MAX_STAKE)`
// is exactly one worst-case round's reservation, which `slice_from_pot` uses as the cap
// when a master pot has no operator-configured `max_slice` (0). It is a conservative
// fail-safe only — the operator sets the REAL per-mint ceiling at `init_house` (decimals
// differ across mints), so this never has to be exactly right, only finite. Chosen large
// enough not to block legitimate play yet small relative to a funded bankroll.
pub const MAX_STAKE: u64 = 1_000_000_000;
// Skull "Death's Door" grace cap (seconds). A round's grace window (the time a
// sub-floor position may ride before the tick liquidates it) is clamped to this at
// `open`. Grace is house-negative — some liqs survive — so it is bounded here; the
// design uses 2s. Zero means no grace (immediate liq), the default for every car
// except Skull.
pub const MAX_GRACE_SECS: u16 = 5;

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
///
/// Rounding is house-favorable PER DIRECTION. price_raw and entry_raw are both > 0
/// (open() enforces entry > 0), so num and den below are > 0. The segment is
/// dir*lev*(ratio - SCALE): flooring the ratio biases it down, which shrinks a LONG
/// segment (house-favorable) but GROWS a SHORT segment (-lev*(ratio-SCALE), player-
/// favorable). So a long floors the ratio (unchanged) and a short CEILs it, pushing the
/// short segment down instead. Both directions now shed the rounding crumb to the house;
/// long-side results stay byte-identical to the pre-fix unsigned floor.
pub fn rebank_fp(banked_fp: i128, dir: i8, lev: u32, entry_raw: i64, price_raw: i64) -> i128 {
    let num = (price_raw as i128) * SCALE; // > 0
    let den = entry_raw as i128; // > 0
    let ratio = if dir >= 0 { num / den } else { (num + den - 1) / den };
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
/// `refund_fp` is the round's Flintstone airbag (SCALE units; 0 = none): what a
/// liquidation settles at instead of the classic 0.
pub fn terminal(eq: i128, liq_fp: i128, refund_fp: i128) -> (Outcome, i128) {
    if eq <= liq_fp {
        // Flintstone "Stone-Age Airbag": a liquidation settles like a forced
        // cash-out at min(refund_fp, observed equity), clamped >= 0, through the
        // SAME audited house-favorable payout(stake, eq) path as every other
        // settle. min(refund, equity) because:
        //   - the refund never exceeds what the house actually captured at the
        //     wreck (a gap-through pays the remaining equity, not the full 20%);
        //   - with the standard edge applied, cashing out just above the floor
        //     always pays >= riding into the liq (no liquidation-seeking exploit;
        //     at the stock 0.20 floor both pay ~19%);
        //   - so the house edge is preserved in every regime, by construction.
        // Solvency: refund <= 0.19*stake << max_payout(stake) = 23.75*stake — the
        // existing pre-lock covers it. refund_fp = 0 reproduces the classic
        // pay-nothing liq byte-for-byte. Outcome stays Liq (clients key UI off it).
        (Outcome::Liq, refund_fp.min(eq.max(0)))
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
#[allow(clippy::too_many_arguments)]
pub fn settle(
    banked_fp: i128,
    dir: i8,
    lev: u32,
    stake: u64,
    entry_raw: i64,
    exit_raw: i64,
    liq_fp: i128,
    refund_fp: i128,
) -> (Outcome, u64) {
    let (o, eq) = terminal(
        equity_fp(banked_fp, dir, lev, entry_raw, exit_raw),
        liq_fp,
        refund_fp,
    );
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
    // refund_fp = 0 here: the airbag changes WHAT a liq pays, never WHETHER it
    // fires, and the settled equity is discarded — only the outcome class matters.
    let (term, _) = terminal(equity_fp(banked_fp, dir, lev, entry_raw, exit_raw), liq_fp, 0);
    term != Outcome::Cashout || now >= deadline_ts
}

/// What the permissionless tick/crank should do at one mark. This extends the plain
/// `fires()` terminal check (used by flip/lever) with the Skull grace window and the
/// Pink Rod SL/TP thresholds, which are TICK-ONLY conveniences — a manual close /
/// flip / lever still settles at the current mark via the standard path.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TickAction {
    /// A terminal (liq/cap/time) OR a Pink Rod SL/TP crossed → settle at this mark.
    Settle,
    /// Skull grace: first sub-floor tick of a fresh breach → record `liq_breach_ts = now`.
    StampBreach,
    /// Skull grace: climbed back above the floor within the window → reset `liq_breach_ts = 0`.
    ClearBreach,
    /// Nothing crossed (benign heartbeat, or breached-but-still-within-grace) → leave open.
    Hold,
}

/// Decide the tick's action at this mark. Returns ONLY the decision — the outcome and
/// payout stay in the shared settle body (`settle_round` → `settle::settle`): an SL/TP
/// exit settles as a normal Cashout at the observed equity, and a grace-elapsed liq as a
/// normal Liq, so this function never duplicates the payout math.
///
/// Precedence before the deadline:
///   equity <= liq_fp → liquidation (Skull grace may StampBreach/Hold before it fires)
///   equity >= CAP_FP → cap (max win)
///   equity >= tp_fp  → Pink Rod take-profit  (kept below CAP by `open`)
///   equity <= sl_fp  → Pink Rod stop-loss    (kept above liq_fp by `open`, so a gap
///                                              THROUGH sl to below the floor liquidates
///                                              instead — liq is checked first)
///   otherwise        → ClearBreach if a grace breach was pending, else Hold
/// At/after `deadline_ts` the round always settles at the mark (grace/SL/TP can't
/// outlive the round); the shared settle body relabels a plain cashout to Time.
#[allow(clippy::too_many_arguments)]
pub fn tick_action(
    banked_fp: i128,
    dir: i8,
    lev: u32,
    entry_raw: i64,
    exit_raw: i64,
    now: i64,
    deadline_ts: i64,
    liq_fp: i128,
    grace_secs: i64,
    liq_breach_ts: i64,
    sl_fp: i128,
    tp_fp: i128,
) -> TickAction {
    // The deadline is terminal — settle now, whatever the grace/SL/TP state.
    if now >= deadline_ts {
        return TickAction::Settle;
    }

    let eq = equity_fp(banked_fp, dir, lev, entry_raw, exit_raw);

    // Liquidation, with the Skull grace window layered on top.
    if eq <= liq_fp {
        if grace_secs <= 0 {
            return TickAction::Settle; // no grace: immediate liquidation
        }
        if liq_breach_ts == 0 {
            return TickAction::StampBreach; // first sub-floor tick → enter the window
        }
        if now - liq_breach_ts >= grace_secs {
            return TickAction::Settle; // window elapsed, still under → wiped
        }
        return TickAction::Hold; // within the grace window, praying for a recovery
    }

    // Above the floor.
    if eq >= CAP_FP {
        return TickAction::Settle; // cap (max win)
    }
    if tp_fp > 0 && eq >= tp_fp {
        return TickAction::Settle; // Pink Rod take-profit
    }
    if sl_fp > 0 && eq <= sl_fp {
        return TickAction::Settle; // Pink Rod stop-loss
    }
    // Nothing crossed. If we were mid-grace, we climbed back out → clear the breach.
    if liq_breach_ts != 0 {
        return TickAction::ClearBreach;
    }
    TickAction::Hold
}

#[cfg(test)]
mod tests {
    use super::*;

    // banked = 0 path (Phase-1 parity): long, 100x, +1% => equity 2.0x, cashout.
    #[test]
    fn long_winner_no_bank() {
        let (o, p) = settle(0, 1, 100, 1_000_000, 60_000, 60_600, LIQ_FP, 0);
        assert_eq!(o, Outcome::Cashout);
        assert_eq!(p, 1_900_000); // floor(1e6 * 2e6 * 950_000 / 1e12)
    }

    // banked = 0: long, 1000x, -0.1% => equity 0 <= LIQ => Liq, payout 0.
    #[test]
    fn long_liquidated_no_bank() {
        let (o, p) = settle(0, 1, 1000, 1_000_000, 60_000, 59_940, LIQ_FP, 0);
        assert_eq!(o, Outcome::Liq);
        assert_eq!(p, 0);
    }

    // cap clamp: long, 2000x, +1.5% => raw equity 31x >= CAP => Cap, payout = max_payout.
    #[test]
    fn cap_clamp_no_bank() {
        let (o, p) = settle(0, 1, 2000, 1_000_000, 60_000, 60_900, LIQ_FP, 0);
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
    //   banked after flip = 0 + 10*(1_100_000-1e6) = 1_000_000  (long leg: floor, exact)
    //   exit segment (dir -1, lev 10, entry 110, exit 105): SHORT leg rounds the ratio UP
    //   (FIX 3, house-favorable per-direction rounding):
    //     ratio = ceil(105*1e6/110) = 954_546; -10*(954_546-1e6) = -10*(-45_454) = 454_540
    //   equity = 1e6 + 1_000_000 + 454_540 = 2_454_540 => cashout.
    // The pre-fix unsigned floor gave ratio 954_545 -> segment 454_550 -> eq 2_454_550;
    // the new short-side ceil shaves the 10-unit crumb (lev 10 * 1 ratio-unit) to the house.
    #[test]
    fn flip_sequence_matches_engine() {
        let banked = rebank_fp(0, 1, 10, 100, 110);
        let eq = equity_fp(banked, -1, 10, 110, 105);
        let (o, _) = terminal(eq, LIQ_FP, 0);
        assert_eq!(o, Outcome::Cashout);
        assert_eq!(eq, 2_454_540);
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
        assert_eq!(terminal(eq, LIQ_FP, 0).0, Outcome::Liq); // 0.20 floor: wiped
        assert_eq!(terminal(eq, MIN_LIQ_FP, 0), (Outcome::Cashout, 150_000)); // 0.10 floor: survives
    }

    // settle() end-to-end honoring the per-round floor. long 1000x, entry 60_000, exit
    // 59_949 => ratio 999_150, segment 1000*(999_150-1e6) = -850_000, equity 150_000 (0.15x):
    // Liq (payout 0) at the 0.20 floor; Cashout (payout 142_500) at the 0.10 floor.
    #[test]
    fn settle_honors_per_round_floor() {
        let (o_hi, p_hi) = settle(0, 1, 1000, 1_000_000, 60_000, 59_949, LIQ_FP, 0);
        assert_eq!(o_hi, Outcome::Liq);
        assert_eq!(p_hi, 0);
        let (o_lo, p_lo) = settle(0, 1, 1000, 1_000_000, 60_000, 59_949, MIN_LIQ_FP, 0);
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

    // --- Skull grace + Pink Rod SL/TP: tick_action decisions ---
    // Vectors reuse the proven equity marks: 1000x long entry 60_000 exit 59_949 => 0.15x
    // (sub the 0.20 floor); 100x long +1% => 2.0x; 100x long -0.5% => 0.5x; +0.1% => 1.1x.

    // grace_secs 0 (every non-Skull car) → the classic immediate liq on a sub-floor mark.
    #[test]
    fn grace_zero_liquidates_immediately() {
        let a = tick_action(0, 1, 1000, 60_000, 59_949, 100, 1_000_000, LIQ_FP, 0, 0, 0, 0);
        assert_eq!(a, TickAction::Settle);
    }

    // Skull grace (2s): first breach stamps, next tick within the window holds, then once
    // 2s have elapsed and equity is STILL under the floor it finally liquidates.
    #[test]
    fn grace_stamps_then_holds_then_liquidates() {
        let first = tick_action(0, 1, 1000, 60_000, 59_949, 100, 1_000_000, LIQ_FP, 2, 0, 0, 0);
        assert_eq!(first, TickAction::StampBreach);
        let within = tick_action(0, 1, 1000, 60_000, 59_949, 101, 1_000_000, LIQ_FP, 2, 100, 0, 0);
        assert_eq!(within, TickAction::Hold); // 1s < 2s window
        let elapsed = tick_action(0, 1, 1000, 60_000, 59_949, 102, 1_000_000, LIQ_FP, 2, 100, 0, 0);
        assert_eq!(elapsed, TickAction::Settle); // 2s >= window, still under → wiped
    }

    // Skull grace: a pending breach with equity recovered above the floor → survived.
    #[test]
    fn grace_clears_breach_on_recovery() {
        // exit back to entry → equity 1.0x (> 0.20 floor); breach was stamped at t=100.
        let a = tick_action(0, 1, 1000, 60_000, 60_000, 101, 1_000_000, LIQ_FP, 2, 100, 0, 0);
        assert_eq!(a, TickAction::ClearBreach);
    }

    // The deadline overrides the grace window: a sub-floor mark at/after the deadline
    // settles immediately even though only 1s of the 2s grace has elapsed.
    #[test]
    fn grace_yields_to_deadline() {
        let a = tick_action(0, 1, 1000, 60_000, 59_949, 200, 200, LIQ_FP, 2, 199, 0, 0);
        assert_eq!(a, TickAction::Settle);
    }

    // Pink Rod take-profit: fires once equity reaches the tp threshold, holds below it.
    #[test]
    fn take_profit_fires_at_threshold() {
        // 2.0x equity, tp 1.5x → eq >= tp → Settle (settle_round renders a Cashout at 2.0x).
        let hit = tick_action(0, 1, 100, 60_000, 60_600, 100, 1_000_000, LIQ_FP, 0, 0, 0, 1_500_000);
        assert_eq!(hit, TickAction::Settle);
        // tp 3.0x, equity only 2.0x → not yet.
        let miss = tick_action(0, 1, 100, 60_000, 60_600, 100, 1_000_000, LIQ_FP, 0, 0, 0, 3_000_000);
        assert_eq!(miss, TickAction::Hold);
    }

    // Pink Rod stop-loss: fires once equity falls to the sl threshold (still above the floor).
    #[test]
    fn stop_loss_fires_at_threshold() {
        // 0.5x equity, sl 0.6x → eq <= sl (and > 0.20 floor) → Settle.
        let hit = tick_action(0, 1, 100, 60_000, 59_700, 100, 1_000_000, LIQ_FP, 0, 0, 600_000, 0);
        assert_eq!(hit, TickAction::Settle);
        // sl 0.4x, equity 0.5x → still above the stop → Hold.
        let miss = tick_action(0, 1, 100, 60_000, 59_700, 100, 1_000_000, LIQ_FP, 0, 0, 400_000, 0);
        assert_eq!(miss, TickAction::Hold);
    }

    // A gap straight through the stop-loss to BELOW the liq floor liquidates (payout 0) —
    // the SL does not rescue a gap-through, because liq is checked first.
    #[test]
    fn liq_beats_stop_loss_on_a_gap() {
        // 0.15x equity, sl 0.6x, grace 0 → immediate liq Settle (not an SL cashout).
        let no_grace = tick_action(0, 1, 1000, 60_000, 59_949, 100, 1_000_000, LIQ_FP, 0, 0, 600_000, 0);
        assert_eq!(no_grace, TickAction::Settle);
        // same gap with grace → enters the grace window (StampBreach), still not an SL exit.
        let with_grace = tick_action(0, 1, 1000, 60_000, 59_949, 100, 1_000_000, LIQ_FP, 2, 0, 600_000, 0);
        assert_eq!(with_grace, TickAction::StampBreach);
    }

    // No thresholds, favorable move, before the deadline → benign heartbeat.
    #[test]
    fn benign_tick_holds() {
        let a = tick_action(0, 1, 100, 60_000, 60_060, 100, 1_000_000, LIQ_FP, 0, 0, 0, 0);
        assert_eq!(a, TickAction::Hold);
    }

    // --- Flintstone "Stone-Age Airbag" (refund_fp): a liquidation settles like a
    // forced cash-out at min(refund_fp, observed equity), through the SAME
    // house-favorable payout() as every other outcome. Stake 1e6 throughout.

    // Max airbag (0.20) at the stock 0.20 floor: observed eq == the floor →
    // settled = min(200_000, 200_000) → payout 190_000 (19% of stake at EDGE 5%),
    // exactly what a Cashout at eq 0.20 would pay — the indifference property
    // (riding into the liq never beats cashing out just above the floor).
    #[test]
    fn airbag_pays_refund_at_the_floor() {
        // 1000x long, entry 1_000_000, exit 999_200 → eq = 1e6 + 1000*(-800) = 200_000.
        let (o, p) = settle(0, 1, 1000, 1_000_000, 1_000_000, 999_200, LIQ_FP, 200_000);
        assert_eq!(o, Outcome::Liq); // outcome stays Liq — clients key UI off it
        assert_eq!(p, payout(1_000_000, 200_000)); // == a Cashout at eq 0.20
        assert_eq!(p, 190_000); // floor(1e6 * 200_000 * 950_000 / 1e12)
    }

    // Gap-through: the wreck happened BELOW the airbag — the refund never exceeds
    // what the house actually captured. Observed eq 0.08 → pays the wreck value.
    #[test]
    fn airbag_gap_through_pays_wreck_value() {
        // 1000x long, exit 999_080 → eq = 1e6 + 1000*(-920) = 80_000 (0.08x).
        let (o, p) = settle(0, 1, 1000, 1_000_000, 1_000_000, 999_080, LIQ_FP, 200_000);
        assert_eq!(o, Outcome::Liq);
        assert_eq!(p, payout(1_000_000, 80_000)); // not the full 20%
        assert_eq!(p, 76_000);
    }

    // Negative-equity gap: the max(eq, 0) clamp floors the settled equity at 0 →
    // payout 0. (settle()'s equity_fp already clamps at 0; terminal's own clamp is
    // belt-and-braces for direct callers.)
    #[test]
    fn airbag_negative_equity_pays_zero() {
        let (o, eq) = terminal(-50_000, LIQ_FP, 200_000);
        assert_eq!(o, Outcome::Liq);
        assert_eq!(eq, 0);
        assert_eq!(payout(1_000_000, eq), 0);
    }

    // refund_fp = 0 (every non-Flintstone car): byte-for-byte the classic
    // pay-nothing liquidation.
    #[test]
    fn no_airbag_liq_pays_zero() {
        let (o, p) = settle(0, 1, 1000, 1_000_000, 60_000, 59_940, LIQ_FP, 0);
        assert_eq!(o, Outcome::Liq);
        assert_eq!(p, 0);
    }

    // Suspension interplay: the airbag settles against the round's OWN floor.
    // Floor 0.10, refund 0.20, observed eq exactly 0.10 → settled =
    // min(200_000, 100_000) = 100_000 → ~9.5% of stake.
    #[test]
    fn airbag_honors_suspension_floor() {
        // 1000x long, exit 999_100 → eq = 1e6 + 1000*(-900) = 100_000 (== 0.10 floor).
        let (o, p) = settle(0, 1, 1000, 1_000_000, 1_000_000, 999_100, MIN_LIQ_FP, 200_000);
        assert_eq!(o, Outcome::Liq);
        assert_eq!(p, payout(1_000_000, 100_000));
        assert_eq!(p, 95_000);
    }

    // --- FIX 3: house-favorable rounding is now PER-DIRECTION. ---

    // Regression for the short-side rounding arbitrage. Before the fix, rebank_fp
    // floored the UNSIGNED ratio, which biases a SHORT segment (-lev*(ratio-SCALE)) UP
    // in the player's favor. Reanchoring a short at lev 3000 on a near-flat oscillating
    // price banked ~+3_000 SCALE-units per 2-reanchor cycle and crossed the 5% edge
    // (EDGE_FP = 50_000) in ~18 cycles — a repeatable arbitrage. With ceil-for-short
    // rounding the crumb flips house-favorable, so `banked` only ever loses ground.
    #[test]
    fn short_reanchor_no_rounding_arbitrage() {
        // A 1-unit wobble around a ~60_000 mark (entries alternate 60_000 <-> 60_001, a
        // ~0.0017% move) whose true round-trip P&L is a negligible drag — any positive
        // banked would be pure rounding profit. dir stays -1 (short) the whole loop.
        let lo: i64 = 60_000;
        let hi: i64 = 60_001;
        let lev: u32 = 3000;
        let mut banked: i128 = 0;
        let mut entry = lo;
        // 30 full cycles = 60 reanchors, well past the pre-fix ~18-cycle edge crossing.
        for _ in 0..30 {
            banked = rebank_fp(banked, -1, lev, entry, hi);
            entry = hi;
            // Pre-fix, the DOWN-reanchor below pushed banked to +3_000 here (arbitrage).
            assert!(banked <= 0, "short banked went positive after up-reanchor: {banked}");
            banked = rebank_fp(banked, -1, lev, entry, lo);
            entry = lo;
            assert!(banked <= 0, "short banked went positive after down-reanchor: {banked}");
        }
        // Never crossed the house edge into net player profit (pre-fix reached > +50_000).
        assert!(banked < EDGE_FP, "banked crossed the house edge: {banked}");
        // Every cycle sheds the crumb to the house, so banked ends strictly negative.
        assert!(banked < 0, "expected a net house-favorable drag, got {banked}");
    }

    // The LONG path is byte-identical to the pre-fix unsigned floor (dir >= 0 => floor).
    // Same non-exact 60_000<->60_001 input as the short regression, proving only the short
    // side changed and a long still loses its rounding crumb DOWN to the house.
    #[test]
    fn long_reanchor_still_floors() {
        // up move: ratio floor(60_001*1e6/60_000) = 1_000_016; +3000*16 = +48_000.
        assert_eq!(rebank_fp(0, 1, 3000, 60_000, 60_001), 48_000);
        // down move: ratio floor(60_000*1e6/60_001) = 999_983; +3000*(999_983-1e6) = -51_000.
        assert_eq!(rebank_fp(0, 1, 3000, 60_001, 60_000), -51_000);
    }
}
