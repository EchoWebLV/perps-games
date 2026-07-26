use anchor_lang::prelude::*;

// PDA seeds. `book`/`race` are singletons per mint; `bettor`/`ticket` are per player.
pub const BOOK_SEED: &[u8] = b"book";
pub const RACE_SEED: &[u8] = b"race";
pub const BETTOR_SEED: &[u8] = b"bettor";
pub const TICKET_SEED: &[u8] = b"ticket";
pub const VAULT_SEED: &[u8] = b"vault";

pub const GRID: usize = 8;
pub const HISTORY_LEN: usize = 32;

// Phase durations. RACE_SECS exceeds the client's own worst case (last place
// finishes at 30 + 7*0.8 + rng*0.4 ~= 36.0s, redline3d/src/render/race-mode.ts:351)
// so the chain sets the window and the client renders inside it.
pub const MARKET_SECS: i64 = 15;
pub const RACE_SECS: i64 = 40;
pub const FINISH_SECS: i64 = 6;

// Reject prices older than this, matching raider's state.rs:71.
pub const STALE_SECS: i64 = 30;

// Phase codes.
pub const PHASE_MARKET: u8 = 0;
pub const PHASE_RACING: u8 = 1;
pub const PHASE_SETTLED: u8 = 2;

/// House bankroll + rake sink. Same layout as raider's HouseBalance so the
/// vault/deposit/withdraw plumbing transfers unchanged.
#[account]
pub struct Book {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub balance: u64,
    pub locked: u64,
    pub bump: u8,
}
impl Book {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

/// Per-player play balance. Same layout as raider's PlayerBalance.
#[account]
pub struct Bettor {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub balance: u64,
    pub bump: u8,
}
impl Bettor {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 1;
}

/// One player's stakes in the CURRENT race. Seeds deliberately carry no race id:
/// the player delegates once and reuses this every race. Staleness is detected by
/// comparing `race_seq` against the live Race, mirroring the round-corpse
/// reconciliation in redline3d/src/chain/game-session.ts:385.
#[account]
pub struct Ticket {
    pub owner: Pubkey,
    pub race_seq: u64,
    pub stakes: [u64; GRID],
    pub bump: u8,
}
impl Ticket {
    pub const SIZE: usize = 8 + 32 + 8 + 8 * GRID + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct RaceResult {
    pub seq: u64,
    pub winner: u8,
    pub mult_fp: u64,
}
impl RaceResult {
    pub const SIZE: usize = 8 + 1 + 8;
}

/// The singleton live race. Delegated once, permanently; never undelegated.
#[account]
pub struct Race {
    pub mint: Pubkey,
    pub seq: u64,
    pub phase: u8,
    pub phase_ends_ts: i64,
    pub entrants: [u8; GRID],
    pub strengths: [u16; GRID],
    pub pools: [u64; GRID],
    pub total: u64,
    pub order: [u8; GRID],
    pub seed: [u8; 32],
    pub feed: Pubkey,
    pub rake_accrued: u64,
    pub history: [RaceResult; HISTORY_LEN],
    pub bump: u8,
}
impl Race {
    pub const SIZE: usize = 8
        + 32                        // mint
        + 8                         // seq
        + 1                         // phase
        + 8                         // phase_ends_ts
        + GRID                      // entrants
        + 2 * GRID                  // strengths
        + 8 * GRID                  // pools
        + 8                         // total
        + GRID                      // order
        + 32                        // seed
        + 32                        // feed
        + 8                         // rake_accrued
        + HISTORY_LEN * RaceResult::SIZE
        + 1; // bump

    /// Slot-keyed ring lookup: O(1), and staleness is self-evident — if
    /// `history[seq % HISTORY_LEN].seq != seq` that race has been overwritten.
    pub fn find_result(&self, seq: u64) -> Option<&RaceResult> {
        let slot = (seq as usize) % HISTORY_LEN;
        let r = &self.history[slot];
        if r.seq == seq {
            Some(r)
        } else {
            None
        }
    }

    /// Push a result into the ring at the slot keyed by seq.
    pub fn push_result(&mut self, r: RaceResult) {
        let slot = (r.seq as usize) % HISTORY_LEN;
        self.history[slot] = r;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_sizes_are_locked() {
        assert_eq!(Book::SIZE, 89);
        assert_eq!(Bettor::SIZE, 81);
        assert_eq!(Ticket::SIZE, 113);
        assert_eq!(Race::SIZE, 778);
    }

    #[test]
    fn race_fits_in_one_account_realloc_free() {
        // 10 KiB is the CPI-safe ceiling for account creation without realloc.
        assert!(Race::SIZE < 10_240);
    }
}
