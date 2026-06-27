// state.rs — on-chain account layouts + invariant constants for the raider program.
//
// Two delegatable u64 ledgers (PlayerBalance, HouseBalance) track *play* balances;
// real USDC sits in a program-owned vault token account (the ATA of the
// `[b"vault", mint]` authority PDA). The Round PDA holds the entry snapshot + the
// house pre-lock for one in-flight round. All three PDAs are co-delegated to the
// MagicBlock ER for the open/close loop (Tasks 6–8).

use anchor_lang::prelude::*;

pub const MAX_ROUND_SECS: i64 = 300; // liveness backstop, NOT the game time-cap (Phase 2)
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
}
impl Round {
    pub const SIZE: usize = 8 + 32 + 1 + 4 + 8 + 8 + 4 + 8 + 8 + 8 + 1 + 1;
}
