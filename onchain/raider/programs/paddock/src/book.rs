//! Pure pari-mutuel math. No Anchor types — runs under plain `cargo test`.
//!
//! All division floors, which is house-favorable: the sum of floored payouts can
//! only ever be <= the payable pool, never more. `payouts_never_exceed_payable`
//! locks that property.

pub const SCALE: u64 = 1_000_000;
/// 5% rake, matching RAKE in redline3d/src/core/race-payout.ts (locked by
/// race-payout.test.ts).
pub const RAKE_FP: u64 = 50_000;

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
}
