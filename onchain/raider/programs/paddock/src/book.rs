//! Pure pari-mutuel math. No Anchor types — runs under plain `cargo test`.
//!
//! All division floors, which is house-favorable: the sum of floored payouts can
//! only ever be <= the payable pool, never more.
//! `payouts_never_exceed_payable_under_rounding` locks that property.

pub const SCALE: u64 = 1_000_000;
/// 5% rake, matching RAKE in redline3d/src/core/race-payout.ts (locked by
/// race-payout.test.ts).
pub const RAKE_FP: u64 = 50_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub mult_fp: u64,
    pub rake: u64,
}

/// Split `total` into rake and a per-unit multiplier for stakes on the winner.
pub fn settle_pool(total: u64, winner_pool: u64) -> Settlement {
    if winner_pool == 0 {
        // Nobody backed the winner. There are no stakes to divide by and no claim
        // can reference this race, so the house takes the pool. Explicit branch,
        // not an accidental divide-by-zero.
        return Settlement { mult_fp: 0, rake: total };
    }
    let rake = ((total as u128) * (RAKE_FP as u128) / (SCALE as u128)) as u64;
    let payable = total - rake;
    let mult_fp = ((payable as u128) * (SCALE as u128) / (winner_pool as u128)) as u64;
    Settlement { mult_fp, rake }
}

/// One bettor's gross payout for `stake` on the winning car.
pub fn payout_of(stake: u64, mult_fp: u64) -> u64 {
    ((stake as u128) * (mult_fp as u128) / (SCALE as u128)) as u64
}

/// What one call of the L1 rake sweep may credit, and the mark it leaves behind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sweep {
    /// Credit the house THIS call. Zero whenever the committed counter has not
    /// moved past the mark.
    pub credit: u64,
    /// The high-water mark to store afterwards. Never below the one passed in.
    pub high_water: u64,
}

/// Diff a CUMULATIVE rake counter against a high-water mark.
///
/// `Race.rake_accrued` only ever grows (lib.rs `race_crank` `checked_add`s into
/// it and nothing subtracts), and it lives in the rollup — L1 sees it only as
/// whatever the last `commit_race` published. So the L1 sweep cannot ask "how
/// much rake is new?" of the counter itself; it has to remember how far it has
/// already credited. That memory is `high_water`.
///
/// EXACTLY-ONCE, stated precisely. Over any sequence of observed committed
/// values `c1..cn` starting from `high_water = 0`, the total credited is
/// `max(c1..cn)` and the final mark equals it. Proof: `saturating_sub` makes
/// each step credit `max(0, ci - h)` and set `h' = max(h, ci)`, so `h` is the
/// running maximum by induction, and each step's credit is exactly the increase
/// of that running maximum. Summing a telescoping series of increases gives the
/// final maximum. Every unit of rake is therefore credited once and only once,
/// regardless of how many times the sweep runs or in what order values arrive.
///
/// Two consequences worth naming because they are the whole reason this is
/// `saturating_sub` and not a plain subtraction:
///
///   * STALE COMMIT (the common case). If `commit_race` has not run recently,
///     `committed` lags the rollup's real counter. The sweep under-credits, and
///     the shortfall is picked up whole by the next sweep after the next commit,
///     because the counter is cumulative — nothing is lost by crediting late.
///     Under-crediting self-corrects; over-crediting could not.
///
///   * BACKWARDS COMMIT. Nothing in the delegation protocol promises L1 sees
///     commits in order, so `committed` may be BELOW the mark. Then the delta is
///     zero and the mark holds — the sweep no-ops rather than crediting a
///     negative or, worse, wrapping.
pub fn sweep_rake(committed_rake: u64, high_water: u64) -> Sweep {
    let credit = committed_rake.saturating_sub(high_water);
    Sweep {
        credit,
        // == max(high_water, committed_rake), so it cannot overflow: it is
        // always one of the two inputs, never their sum.
        high_water: high_water + credit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rake_is_five_percent() {
        let s = settle_pool(1_000_000, 400_000);
        assert_eq!(s.rake, 50_000);
    }

    #[test]
    fn winner_pool_splits_the_payable_remainder() {
        // total 1_000_000, rake 50_000, payable 950_000, winner pool 400_000
        // mult = 950_000 * 1e6 / 400_000 = 2_375_000 (2.375x)
        let s = settle_pool(1_000_000, 400_000);
        assert_eq!(s.mult_fp, 2_375_000);
        assert_eq!(payout_of(400_000, s.mult_fp), 950_000);
    }

    #[test]
    fn nobody_backed_the_winner_gives_the_whole_pool_to_the_house() {
        let s = settle_pool(1_000_000, 0);
        assert_eq!(s.mult_fp, 0);
        assert_eq!(s.rake, 1_000_000);
        assert_eq!(payout_of(0, s.mult_fp), 0);
    }

    #[test]
    fn empty_race_settles_to_zero() {
        let s = settle_pool(0, 0);
        assert_eq!(s.mult_fp, 0);
        assert_eq!(s.rake, 0);
    }

    #[test]
    fn payouts_never_exceed_payable_under_rounding() {
        // Three uneven stakes on the winner; floor-division must leave the house
        // whole, never short. This is the conservation property that matters.
        let stakes = [333_333u64, 333_333, 333_334];
        let winner_pool: u64 = stakes.iter().sum();
        let total = winner_pool + 500_000; // losers' money
        let s = settle_pool(total, winner_pool);
        let paid: u64 = stakes.iter().map(|&st| payout_of(st, s.mult_fp)).sum();
        assert!(paid <= total - s.rake, "paid {} > payable {}", paid, total - s.rake);
    }

    #[test]
    fn a_lone_winner_takes_the_whole_payable_pool() {
        let s = settle_pool(1_000_000, 100);
        assert_eq!(payout_of(100, s.mult_fp), 950_000);
    }

    #[test]
    fn large_pools_do_not_overflow() {
        let total = u64::MAX / 4;
        let s = settle_pool(total, total / 2);
        assert!(s.mult_fp > 0);
        assert!(payout_of(total / 2, s.mult_fp) <= total - s.rake);
    }

    // ---- the L1 rake sweep: exactly-once ------------------------------------
    //
    // These are the proof. The instruction in lib.rs is a thin shell around
    // `sweep_rake` — it reads the committed counter, calls this, and writes the
    // two numbers back — so if the invariant holds here it holds on chain.

    #[test]
    fn the_first_sweep_credits_the_whole_committed_counter() {
        let s = sweep_rake(50_000, 0);
        assert_eq!(s.credit, 50_000);
        assert_eq!(s.high_water, 50_000);
    }

    #[test]
    fn a_second_sweep_in_a_row_credits_nothing() {
        // The double-call case, stated on its own because it is the one an
        // operator or a keeper loop will actually hit.
        let first = sweep_rake(50_000, 0);
        let second = sweep_rake(50_000, first.high_water);
        assert_eq!(second.credit, 0);
        assert_eq!(second.high_water, first.high_water);
    }

    #[test]
    fn hammering_the_sweep_credits_the_rake_once() {
        let mut mark = 0u64;
        let mut credited = 0u64;
        for _ in 0..1_000 {
            let s = sweep_rake(50_000, mark);
            credited += s.credit;
            mark = s.high_water;
        }
        assert_eq!(credited, 50_000);
        assert_eq!(mark, 50_000);
    }

    #[test]
    fn a_stale_commit_under_credits_and_the_next_one_catches_up() {
        // Rollup counter reaches 900 but L1 has only seen 300.
        let a = sweep_rake(300, 0);
        assert_eq!(a.credit, 300);
        // A later commit publishes the real figure.
        let b = sweep_rake(900, a.high_water);
        assert_eq!(b.credit, 600);
        assert_eq!(a.credit + b.credit, 900, "the lag lost rake");
    }

    #[test]
    fn a_backwards_commit_credits_nothing_and_never_lowers_the_mark() {
        let a = sweep_rake(900, 0);
        // An older commit lands after a newer one. The counter cannot really go
        // down, so this is a view artifact — it must not credit, and must not
        // rewind the mark or the 900 would be paid twice.
        let b = sweep_rake(300, a.high_water);
        assert_eq!(b.credit, 0);
        assert_eq!(b.high_water, 900);
        let c = sweep_rake(900, b.high_water);
        assert_eq!(c.credit, 0, "rewound mark re-credited already-swept rake");
    }

    #[test]
    fn the_mark_can_not_overflow_at_the_ceiling() {
        let s = sweep_rake(u64::MAX, 0);
        assert_eq!(s.credit, u64::MAX);
        assert_eq!(s.high_water, u64::MAX);
        let again = sweep_rake(u64::MAX, u64::MAX);
        assert_eq!(again.credit, 0);
        assert_eq!(again.high_water, u64::MAX);
    }

    // Deterministic xorshift64* — no dev-dependency, and a failure reproduces
    // from the seed printed in the assert.
    fn rng(state: &mut u64) -> u64 {
        let mut x = *state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        *state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    #[test]
    fn credits_always_sum_to_the_highest_committed_value_ever_seen() {
        // The general statement: ANY sequence of observed committed values —
        // repeats, stalls, backwards jumps — credits exactly the running max.
        for seed in 1..200u64 {
            let mut st = seed;
            let mut mark = 0u64;
            let mut credited = 0u64;
            let mut seen_max = 0u64;
            for _ in 0..64 {
                let committed = rng(&mut st) % 10_000;
                seen_max = seen_max.max(committed);
                let s = sweep_rake(committed, mark);
                credited += s.credit;
                mark = s.high_water;
                assert_eq!(mark, seen_max, "mark is not the running max (seed {seed})");
            }
            assert_eq!(credited, seen_max, "double- or under-credit (seed {seed})");
        }
    }

    #[test]
    fn every_unit_of_race_rake_reaches_the_house_exactly_once() {
        // End to end against the real settlement math, with the two things that
        // make this hard in production: commits that lag by an arbitrary number
        // of races (including never), and sweeps fired at arbitrary moments
        // (including twice in a row, and before any commit at all).
        for seed in 1..120u64 {
            let mut st = seed;

            let mut accrued = 0u64; // the rollup's cumulative counter
            let mut committed = 0u64; // what L1 currently shows
            let mut mark = 0u64; // book.locked
            let mut credited = 0u64; // book.balance

            for _ in 0..80 {
                match rng(&mut st) % 3 {
                    // A race settles in the rollup.
                    0 => {
                        let total = rng(&mut st) % 1_000_000;
                        let winner_pool = if rng(&mut st) % 5 == 0 {
                            0 // nobody backed the winner: the house takes the pool
                        } else {
                            1 + rng(&mut st) % total.max(1)
                        };
                        accrued += settle_pool(total, winner_pool.min(total)).rake;
                    }
                    // commit_race lands the rollup counter on L1.
                    1 => committed = accrued,
                    // Someone calls sweep_rake.
                    _ => {
                        let s = sweep_rake(committed, mark);
                        credited += s.credit;
                        mark = s.high_water;
                        // Never credit rake that has not been earned. This is
                        // the safety half of the invariant; the liveness half
                        // is asserted after the loop.
                        assert!(
                            credited <= accrued,
                            "credited {credited} > accrued {accrued} (seed {seed})"
                        );
                    }
                }
            }

            // Settle up: one commit, one sweep, and the house is whole. Then a
            // second sweep must move nothing.
            committed = accrued;
            let s = sweep_rake(committed, mark);
            credited += s.credit;
            mark = s.high_water;
            assert_eq!(credited, accrued, "house short after catch-up (seed {seed})");
            let again = sweep_rake(committed, mark);
            assert_eq!(again.credit, 0, "catch-up sweep was repeatable (seed {seed})");
        }
    }
}
