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

// Bounds for the client-requested round duration (the Long-Range Tank upgrade extends the round
// past the base 60s). `open` clamps the requested seconds into this range; MIN stays small enough
// to keep the `test-short-deadline` (8s) suite valid, HARD_MAX caps abuse well above the Tank's
// ~120s top. A requested duration of 0 (or less) means "use the default", MAX_ROUND_SECS.
pub const MIN_ROUND_SECS: i64 = 5;
pub const HARD_MAX_ROUND_SECS: i64 = 180;

/// Client wire value that requests an open-ended Highway round. Timed Track
/// rounds keep using zero/default or a positive bounded duration.
pub const HIGHWAY_DURATION_SENTINEL: i64 = -1;

/// Encode an open-ended round identity in the existing deadline field. Negative
/// values can never collide with positive Track deadlines, and the slot keeps
/// consecutive Highway rounds distinct without resizing the Round account.
pub fn highway_round_marker(slot: u64) -> Option<i64> {
    i64::try_from(slot).ok().map(|slot| -slot.max(1))
}

pub fn deadline_for_open(dur: i64, now: i64, slot: u64) -> Option<i64> {
    if dur == HIGHWAY_DURATION_SENTINEL {
        return highway_round_marker(slot);
    }
    let secs = if dur <= 0 {
        MAX_ROUND_SECS
    } else {
        dur.clamp(MIN_ROUND_SECS, HARD_MAX_ROUND_SECS)
    };
    now.checked_add(secs)
}

// Flintstone "Stone-Age Airbag" ceiling (SCALE units): the max fraction of stake a
// liquidation can refund. 20% — at the stock 0.20 liq floor the airbag then pays
// exactly what a cash-out at the floor would (see settle::terminal), so it can never
// beat exiting voluntarily. `open` clamps the client-requested refund_fp to this.
pub const MAX_REFUND_FP: u32 = 200_000;

/// Clamp a client-requested airbag refund into [0, MAX_REFUND_FP] (u32 is already >= 0).
pub fn clamp_refund_fp(requested: u32) -> u32 {
    requested.min(MAX_REFUND_FP)
}

pub const STALE_SECS: i64 = 30; // reject settle against prices older than this

// PDA seeds (kept here so every instruction context derives them identically).
pub const PLAYER_SEED: &[u8] = b"player";
// v2 ("house2"): the legacy [b"house", wSOL] master-pot PDA on devnet is stuck
// owned by the delegation program — it was delegated by a pre-upgrade session that
// can no longer be undelegated (no instruction exists that undelegates a house
// account). Versioning the seed re-homes the bankroll at a fresh address so wSOL
// stakes can bootstrap; the stranded v1 account is abandoned in place.
pub const HOUSE_SEED: &[u8] = b"house2";
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
/// `[HOUSE_SEED, mint]` (the bankroll; never delegated) AND each per-session till
/// `[HOUSE_SEED, mint, owner]` (carved off the master, co-delegated with Player+Round
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
    // This is a deployed ABI: the production master pot and existing session tills are 89 bytes.
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
    // Per-round liquidation floor in SCALE units (1e6): equity <= liq_fp => liquidated.
    // Stamped at `open` (default 0.20 = 200_000; the Suspension upgrade lowers it toward
    // 0.10 = 100_000). Part of the provable-fairness record — settle honors THIS value,
    // so a round's liq threshold is fixed and recomputable from on-chain data alone.
    pub liq_fp: u32,
    // Skull "Death's Door" — auto-liquidation grace window, in SECONDS (0 = none, the
    // default for every non-Skull car). When set, a tick that finds equity <= liq_fp does
    // NOT settle immediately: it records the breach (liq_breach_ts) and only liquidates if
    // equity is STILL under the floor grace_secs later. Recovering above the floor within
    // the window clears the breach (survived). ONLY the permissionless tick/crank honors
    // this — a manual close/flip/lever settles at the current mark. House-negative (some
    // liqs survive), so `open` caps it at MAX_GRACE_SECS.
    pub grace_secs: u16,
    // Pink Rod stop-loss / take-profit equity thresholds (SCALE units; 0 = unset). The
    // permissionless tick/crank auto-cashes-out when equity falls to <= sl_fp (kept strictly
    // ABOVE the liq floor) or rises to >= tp_fp (kept strictly BELOW cap). Both settle as a
    // normal Cashout at the observed mark, so they never change the payout math — only WHEN
    // the round exits. Stamped at `open`, honored only by the tick path, on-chain for the life
    // of the round (provable).
    pub sl_fp: u32,
    pub tp_fp: u32,
    pub status: u8,
    pub bump: u8,
    // --- settlement record (written at settle; zero while open/idle) ---
    pub exit_raw: i64,
    pub exit_ts: i64,
    pub payout: u64,
    pub outcome: u8,
    // Skull grace runtime record: unix ts of the CURRENT (or, once liquidated, the final)
    // sub-floor breach; 0 = never breached / recovered. Written by the tick (stamp on first
    // breach, clear on recovery), and NOT reset at settle — so a liquidated grace round proves
    // the window was honored (exit_ts - liq_breach_ts >= grace_secs). Reset to 0 at `open`.
    pub liq_breach_ts: i64,
    // Flintstone "Stone-Age Airbag" — SCALE-units fraction of stake refunded on a
    // liquidation (0 = no airbag, the default for every non-Flintstone car). A liq
    // settles like a forced cash-out at min(refund_fp, observed equity) through the
    // standard house-favorable payout path (see settle::terminal). Stamped at `open`
    // (clamped to MAX_REFUND_FP), honored by EVERY liquidation entry point, on-chain
    // for the life of the round (provable). Independent of grace_secs: grace decides
    // WHEN a liq fires, refund decides WHAT it pays — both may be set.
    pub refund_fp: u32,
}
impl Round {
    // disc(8) + owner(32) + feed(32) + dir(1) + lev(4) + stake(8) + entry_raw(8)
    //  + entry_expo(4) + entry_ts(8) + banked(16) + max_payout(8) + deadline_ts(8)
    //  + liq_fp(4) + grace_secs(2) + sl_fp(4) + tp_fp(4) + status(1) + bump(1)
    //  + exit_raw(8) + exit_ts(8) + payout(8) + outcome(1) + liq_breach_ts(8)
    //  + refund_fp(4) = 190
    pub const SIZE: usize = 8
        + 32 + 32 + 1 + 4 + 8 + 8 + 4 + 8 + 16 + 8 + 8 + 4 + 2 + 4 + 4 + 1 + 1 + 8 + 8 + 8 + 1 + 8
        + 4;
}

#[cfg(test)]
mod size_tests {
    use super::*;

    #[test]
    fn highway_marker_is_negative_and_slot_specific() {
        assert_eq!(highway_round_marker(42), Some(-42));
        assert_ne!(highway_round_marker(42), highway_round_marker(43));
        assert_eq!(highway_round_marker(0), Some(-1));
    }

    #[test]
    fn open_deadline_selects_highway_or_bounded_track_semantics() {
        assert_eq!(deadline_for_open(HIGHWAY_DURATION_SENTINEL, 100, 42), Some(-42));
        assert_eq!(deadline_for_open(0, 100, 42), Some(100 + MAX_ROUND_SECS));
        assert_eq!(deadline_for_open(999, 100, 42), Some(100 + HARD_MAX_ROUND_SECS));
    }
    #[test]
    fn round_size_includes_feed() {
        // 132 + 32 (feed: Pubkey) = 164; + 4 (liq_fp) = 168; + grace_secs(2) + sl_fp(4)
        // + tp_fp(4) + liq_breach_ts(8) = 186 (Skull grace + Pink Rod SL/TP fields);
        // + refund_fp(4) = 190 (Flintstone airbag).
        assert_eq!(Round::SIZE, 190);
    }
    #[test]
    fn feed_registry_size_fits_eight_entries() {
        // disc(8) + authority(32) + bump(1) + 8 * (feed 32 + feed_id 32 + enabled 1 = 65) = 561
        assert_eq!(FeedRegistry::SIZE, 8 + 32 + 1 + 8 * 65);
    }
    #[test]
    fn house_size_stays_compatible_with_deployed_pots() {
        // The devnet master pot and every pre-upgrade session till were allocated with
        // this 89-byte ABI. A program upgrade must not make those live ledgers unreadable.
        assert_eq!(HouseBalance::SIZE, 89);
    }
    #[test]
    fn refund_clamps_to_ceiling() {
        assert_eq!(clamp_refund_fp(500_000), MAX_REFUND_FP); // over the 20% ceiling → clamped
        assert_eq!(clamp_refund_fp(150_000), 150_000); // in range → untouched
        assert_eq!(clamp_refund_fp(0), 0); // no airbag
    }
}
