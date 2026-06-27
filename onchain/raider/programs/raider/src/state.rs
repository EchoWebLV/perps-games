// state.rs — on-chain account layouts + invariant constants for the raider program.
//
// Two delegatable u64 ledgers (PlayerBalance, HouseBalance) track *play* balances;
// real USDC sits in a program-owned vault token account (the ATA of the
// `[b"vault", mint]` authority PDA). The Round PDA holds the entry snapshot + the
// house pre-lock for one in-flight round. All three PDAs are co-delegated to the
// MagicBlock ER for the open/close loop (Tasks 6–8).

use anchor_lang::prelude::*;

// Liveness backstop after which ANYONE can `force_close` a stalled round, NOT
// the game time-cap (that's Phase 2). 300s in prod; the `test-short-deadline`
// build feature shrinks it to 8s so the force_close post-deadline path can be
// exercised in an integration test without a 5-minute wait. MUST be off in any
// real deployment.
#[cfg(not(feature = "test-short-deadline"))]
pub const MAX_ROUND_SECS: i64 = 300;
#[cfg(feature = "test-short-deadline")]
pub const MAX_ROUND_SECS: i64 = 8;

pub const STALE_SECS: i64 = 30; // reject settle against prices older than this

// PDA seeds (kept here so every instruction context derives them identically).
pub const PLAYER_SEED: &[u8] = b"player";
pub const HOUSE_SEED: &[u8] = b"house";
pub const ROUND_SEED: &[u8] = b"round";
pub const VAULT_SEED: &[u8] = b"vault";

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

// status: 0 idle, 1 open, 2 settled
//
// The exit fields below are written at `close` so a settled Round is a
// SELF-CONTAINED proof: anyone can recompute payout from the stored
// (dir, lev, stake, entry_raw, exit_raw) with the same fixed-point math in
// settle.rs — no racy live-feed re-read required to verify fairness.
// outcome: 0 cashout, 1 cap, 2 liq.
#[account]
pub struct Round {
    pub owner: Pubkey,
    pub dir: i8,
    pub lev: u32,
    pub stake: u64,
    pub entry_raw: i64,
    pub entry_expo: i32,
    pub entry_ts: i64,
    pub max_payout: u64,
    pub deadline_ts: i64,
    pub status: u8,
    pub bump: u8,
    // --- settlement record (written at close; zero while open/idle) ---
    pub exit_raw: i64,
    pub exit_ts: i64,
    pub payout: u64,
    pub outcome: u8,
}
impl Round {
    // disc(8) + owner(32) + dir(1) + lev(4) + stake(8) + entry_raw(8)
    //  + entry_expo(4) + entry_ts(8) + max_payout(8) + deadline_ts(8)
    //  + status(1) + bump(1)                                  = 91 (base)
    //  + exit_raw(8) + exit_ts(8) + payout(8) + outcome(1)    = 25 (record)
    //  = 116 total.
    pub const SIZE: usize =
        8 + 32 + 1 + 4 + 8 + 8 + 4 + 8 + 8 + 8 + 1 + 1 + 8 + 8 + 8 + 1;
}
