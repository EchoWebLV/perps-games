// state.rs — on-chain account layouts + invariant constants for the raider program.
//
// Two delegatable u64 ledgers (PlayerBalance, HouseBalance) track *play* balances;
// real USDC sits in a program-owned vault token account (the ATA of the
// `[b"vault", mint]` authority PDA). The Round PDA holds the entry snapshot + the
// house pre-lock for one in-flight round. All three PDAs are co-delegated to the
// MagicBlock ER for the open/close loop (Tasks 6–8).

use anchor_lang::prelude::*;

// The game time-cap: a round auto-closes at this age (outcome = time), settling
// at the then-current price. ALSO the permissionless `force_close` deadline (the
// liveness backstop if the keeper/crank AND the player all go silent). 60s in
// prod. Two MUTUALLY EXCLUSIVE test affordances tune the cap (both MUST be off in
// any real deployment):
//   - `test-short-deadline` shrinks it to 8s so the time/force_close paths can be
//     exercised without a long wait;
//   - `test-long-deadline` stretches it to 180s so the permissionless `tick`
//     liquidation can be PROVEN against the live Lazer feed on a calm, mean-
//     reverting market — at 2000x a liq needs only a ~0.04% adverse move, but on a
//     quiet day the cumulative excursion from a held entry can take >60s to cross
//     it, so a 180s window holds one entry long enough for `tick` to observe it.
#[cfg(all(not(feature = "test-short-deadline"), not(feature = "test-long-deadline")))]
pub const MAX_ROUND_SECS: i64 = 60;
#[cfg(feature = "test-short-deadline")]
pub const MAX_ROUND_SECS: i64 = 8;
#[cfg(feature = "test-long-deadline")]
pub const MAX_ROUND_SECS: i64 = 180;

pub const STALE_SECS: i64 = 30; // reject settle against prices older than this

// PDA seeds (kept here so every instruction context derives them identically).
pub const PLAYER_SEED: &[u8] = b"player";
pub const HOUSE_SEED: &[u8] = b"house";
pub const ROUND_SEED: &[u8] = b"round";
pub const VAULT_SEED: &[u8] = b"vault";
pub const FEEDS_SEED: &[u8] = b"feeds";
pub const MAX_ASSETS: usize = 8;

#[account]
pub struct PlayerBalance {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub balance: u64,
    pub bump: u8,
}
impl PlayerBalance {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 1;
}

/// HouseBalance backs BOTH roles in the sharding model: the singleton master pot
/// `[b"house", mint]` (the bankroll; never delegated) AND each per-session till
/// `[b"house", mint, owner]` (carved off the master, co-delegated with Player+Round
/// for one ER session, swept back at end). Identical layout/SIZE for both.
#[account]
pub struct HouseBalance {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub balance: u64,
    pub locked: u64,
    pub bump: u8,
}
impl HouseBalance {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct FeedEntry {
    pub feed: Pubkey,       // the MagicBlock-relayed Pyth Lazer price account
    pub feed_id: [u8; 32],  // decoded Lazer feed_id (defense-in-depth at open)
    pub enabled: bool,
}

#[account]
pub struct FeedRegistry {
    pub authority: Pubkey,
    pub feeds: [FeedEntry; MAX_ASSETS], // indexed by asset id (0=BTC,1=ETH,2=SOL)
    pub bump: u8,
}
impl FeedRegistry {
    pub const SIZE: usize = 8 + 32 + MAX_ASSETS * (32 + 32 + 1) + 1;
}

// status: 0 idle, 1 open, 2 settled
//
// The exit fields below are written at `close` so a settled Round is a
// SELF-CONTAINED proof: anyone can recompute payout from the stored
// (dir, lev, stake, entry_raw, exit_raw) with the same fixed-point math in
// settle.rs — no racy live-feed re-read required to verify fairness.
// outcome: 0 cashout, 1 cap, 2 liq, 3 time.
#[account]
pub struct Round {
    pub owner: Pubkey,
    pub feed: Pubkey, // the price feed this round opened on (bound at open; validated on every settle)
    pub dir: i8,
    pub lev: u32,
    pub stake: u64,
    pub entry_raw: i64,
    pub entry_expo: i32,
    pub entry_ts: i64,
    pub banked: i128, // realized P&L accumulator (SCALE units); mutated by flip/lever
    pub max_payout: u64,
    pub deadline_ts: i64,
    pub status: u8,
    pub bump: u8,
    // --- settlement record (written at settle; zero while open/idle) ---
    pub exit_raw: i64,
    pub exit_ts: i64,
    pub payout: u64,
    pub outcome: u8,
}
impl Round {
    // disc(8) + owner(32) + feed(32) + dir(1) + lev(4) + stake(8) + entry_raw(8)
    //  + entry_expo(4) + entry_ts(8) + banked(16) + max_payout(8) + deadline_ts(8)
    //  + status(1) + bump(1) + exit_raw(8) + exit_ts(8) + payout(8) + outcome(1) = 164
    pub const SIZE: usize =
        8 + 32 + 32 + 1 + 4 + 8 + 8 + 4 + 8 + 16 + 8 + 8 + 1 + 1 + 8 + 8 + 8 + 1;
}

#[cfg(test)]
mod size_tests {
    use super::*;
    #[test]
    fn round_size_includes_feed() {
        // 132 (old) + 32 (feed: Pubkey) = 164
        assert_eq!(Round::SIZE, 164);
    }
    #[test]
    fn feed_registry_size_fits_eight_entries() {
        // disc(8) + authority(32) + bump(1) + 8 * (feed 32 + feed_id 32 + enabled 1 = 65) = 561
        assert_eq!(FeedRegistry::SIZE, 8 + 32 + 1 + 8 * 65);
    }
}
