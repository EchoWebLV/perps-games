//! Weighted finish-order draw. Pure — no Anchor account types — so it runs
//! under plain `cargo test`.
//!
//! Weighted sampling WITHOUT replacement: each rank draws from the remaining
//! cars in proportion to strength. Upsets fall out of the weighting, so there
//! is no separate noise term to tune.
//!
//! Hash choice: the original design called for
//! `anchor_lang::solana_program::keccak::hashv`. That import does not resolve
//! against this workspace's pinned `anchor-lang = "0.32.1"` — verified by
//! compiling it (`error[E0432]: unresolved import
//! anchor_lang::solana_program::keccak`; `no keccak in solana_program`). That
//! anchor-lang version splits `solana-program` into per-syscall micro-crates
//! and does not re-export the deprecated `keccak` module. The replacement,
//! `solana-keccak-hasher`, was already present in this workspace's dependency
//! graph (transitively, via `ephemeral-rollups-sdk` /
//! `magicblock-magic-program-api`, both at v2.2.1 and v3.1.0 — confirmed with
//! `cargo tree`), so it costs no new compiled weight to declare directly in
//! Cargo.toml and use here.

use crate::state::GRID;
use solana_keccak_hasher::hashv;

/// Deterministic 64-bit draw value for draw `counter`, folding in the full
/// 32-byte `seed`.
fn next_u64(seed: &[u8; 32], counter: u64) -> u64 {
    let h = hashv(&[seed, &counter.to_le_bytes()]);
    u64::from_le_bytes(
        h.to_bytes()[..8]
            .try_into()
            .expect("keccak output is 32 bytes"),
    )
}

/// Seed for race `seq`, bound to the authenticated Lazer price read at lock.
///
/// The market opens with `Race.seed` all zeroes; this value only exists once the
/// crank locks the market, so the winner cannot be known while bets are open —
/// the structural fix for the client-side pre-decided outcome at
/// redline3d/src/render/race-mode.ts:363.
pub fn race_seed(seq: u64, price_raw: i64, publish_time: i64) -> [u8; 32] {
    hashv(&[
        &seq.to_le_bytes(),
        &price_raw.to_le_bytes(),
        &publish_time.to_le_bytes(),
    ])
    .to_bytes()
}

/// Produce the finish order: `order[0]` is the winner, `order[7]` is last.
pub fn draw_order(seed: &[u8; 32], strengths: &[u16; GRID]) -> [u8; GRID] {
    let mut remaining: [u8; GRID] = [0, 1, 2, 3, 4, 5, 6, 7];
    let mut n = GRID;
    let mut order = [0u8; GRID];

    for rank in 0..GRID {
        let total: u64 = remaining[..n]
            .iter()
            .map(|&i| strengths[i as usize] as u64)
            .sum();

        // With all-zero strengths every car is equally (un)likely; fall through to
        // the last remaining index rather than dividing by zero.
        let r = if total == 0 {
            0
        } else {
            next_u64(seed, rank as u64) % total
        };

        let mut acc = 0u64;
        let mut pick = n - 1;
        for k in 0..n {
            acc += strengths[remaining[k] as usize] as u64;
            if r < acc {
                pick = k;
                break;
            }
        }

        order[rank] = remaining[pick];
        // Swap-remove keeps this allocation-free and deterministic.
        remaining[pick] = remaining[n - 1];
        n -= 1;
    }

    order
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVEN: [u16; 8] = [1000; 8];
    const LADDER: [u16; 8] = [1000, 1000, 1350, 1350, 1800, 1800, 2400, 3200];

    fn seed_of(n: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = n;
        s
    }

    #[test]
    fn output_is_a_permutation_of_all_eight_cars() {
        for n in 0..50u8 {
            let order = draw_order(&seed_of(n), &LADDER);
            let mut seen = [false; 8];
            for &car in order.iter() {
                assert!((car as usize) < 8, "car index out of range: {}", car);
                assert!(!seen[car as usize], "car {} appeared twice", car);
                seen[car as usize] = true;
            }
        }
    }

    #[test]
    fn same_seed_gives_the_same_order() {
        let a = draw_order(&seed_of(7), &LADDER);
        let b = draw_order(&seed_of(7), &LADDER);
        assert_eq!(a, b);
    }

    #[test]
    fn different_seeds_give_different_orders() {
        let a = draw_order(&seed_of(1), &LADDER);
        let b = draw_order(&seed_of(2), &LADDER);
        assert_ne!(a, b);
    }

    #[test]
    fn stronger_cars_win_more_often() {
        let mut wins = [0u32; 8];
        for n in 0..=255u8 {
            wins[draw_order(&seed_of(n), &LADDER)[0] as usize] += 1;
        }
        // car 7 (strength 3200) must beat car 0 (strength 1000) over 256 draws
        assert!(wins[7] > wins[0], "wins: {:?}", wins);
    }

    #[test]
    fn the_weakest_car_still_wins_sometimes() {
        let mut weak_wins = 0;
        for n in 0..=255u8 {
            if draw_order(&seed_of(n), &LADDER)[0] == 0 {
                weak_wins += 1;
            }
        }
        assert!(weak_wins > 0, "a rarity-1 car must be able to upset");
    }

    #[test]
    fn equal_strengths_still_produce_a_valid_permutation() {
        let order = draw_order(&seed_of(3), &EVEN);
        let mut sorted = order;
        sorted.sort();
        assert_eq!(sorted, [0, 1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn all_zero_strengths_do_not_panic() {
        let order = draw_order(&seed_of(3), &[0u16; 8]);
        let mut sorted = order;
        sorted.sort();
        assert_eq!(sorted, [0, 1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn seed_binds_sequence_price_and_timestamp() {
        let a = race_seed(1, 65_000_00000000, 1_770_000_000);
        let b = race_seed(2, 65_000_00000000, 1_770_000_000);
        let c = race_seed(1, 65_000_00000001, 1_770_000_000);
        let d = race_seed(1, 65_000_00000000, 1_770_000_001);
        assert_ne!(a, b, "seq must change the seed");
        assert_ne!(a, c, "price must change the seed");
        assert_ne!(a, d, "publish time must change the seed");
    }

    #[test]
    fn seed_is_reproducible() {
        assert_eq!(
            race_seed(9, 123_456, 1_770_000_000),
            race_seed(9, 123_456, 1_770_000_000)
        );
    }
}
