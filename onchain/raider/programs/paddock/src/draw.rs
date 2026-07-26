//! Weighted finish-order draw. Pure — no Anchor account types, no external
//! hash crate — so it runs under plain `cargo test`.
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
//! and does not re-export the deprecated `keccak` module; the replacement
//! crate, `solana-keccak-hasher`, is not a direct dependency here. `anchor-spl`,
//! `ephemeral-rollups-sdk`, and `magicblock-magic-program-api` (already in the
//! dependency graph) were also checked and none re-export a reachable hash.
//! Adding a crate means editing Cargo.toml, out of scope for this file-only
//! change. So `next_u64` mixes the seed with SplitMix64 (Steele/Lea/Flood
//! 2014 finalizer; the same one behind Java's `SplittableRandom`) instead of
//! Keccak — dependency-free, deterministic, good avalanche. It is NOT a
//! cryptographic hash: fine for turning an already-committed seed into
//! per-rank weights, since nothing here needs collision resistance, but
//! revisit if the seed's own unpredictability ever comes to depend on this
//! step being hard to invert.

use crate::state::GRID;

/// SplitMix64 finalizer (public-domain construction; not a CSPRNG).
fn splitmix64(x: u64) -> u64 {
    let x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Deterministic 64-bit draw value for draw `counter`, folding in the full
/// 32-byte `seed` (all four 8-byte words, not just a prefix).
fn next_u64(seed: &[u8; 32], counter: u64) -> u64 {
    let mut state = counter;
    for word in seed.chunks_exact(8) {
        let w = u64::from_le_bytes(word.try_into().expect("chunk is 8 bytes"));
        state = splitmix64(state ^ w);
    }
    splitmix64(state)
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
}
