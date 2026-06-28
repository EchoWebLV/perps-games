// price.rs — Pyth Lazer (MagicBlock-relayed) price decoder + staleness gate.
//
// `parse_price_update` is carried VERBATIM from the Phase-0 spike
// (spikes/lazer-probe/programs/lazer-probe/src/lib.rs). It hand-decodes the
// PriceUpdateV2 layout because pyth-solana-receiver-sdk conflicts with
// ephemeral-rollups-sdk over bytemuck_derive. `read_fresh` adds the Phase-1
// staleness check so a round can never settle against a frozen feed.
//
// NOTE (Phase-0 gotcha): on the MagicBlock ER the Lazer exponent is a POSITIVE
// magnitude — USD = price * 10^(-expo). Settlement (settle.rs) divides exit by
// entry on the SAME feed so the exponent cancels; we still store it for clients.

use anchor_lang::prelude::*;

use crate::RaiderError;

// ---------------------------------------------------------------------------
// FEED AUTHENTICATION (the airtight half of the unauthenticated-feed fix).
//
// `read_fresh` used to validate ONLY staleness — it never checked WHICH account
// it was decoding. An attacker could pass any account whose bytes decode to a
// PriceUpdateV2 with an attacker-chosen price + fresh timestamp, force a Cap
// outcome, and drain the house. The primary, airtight fix is the
// `#[account(address = BTC_FEED)]` constraint on the price_update account in
// lib.rs (OpenRound/CloseRound/ForceCloseRound): an attacker simply cannot
// supply an account at a pubkey they don't control. The owner + feed_id checks
// below are defense-in-depth.
// ---------------------------------------------------------------------------

/// The ONLY price account this program will ever read: the MagicBlock-relayed
/// Pyth Lazer BTC/USD feed. Pinned by `#[account(address = BTC_FEED)]` at every
/// settle site so no attacker-controlled account can be substituted.
pub const BTC_FEED: Pubkey = pubkey!("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");

/// Owner program of the BTC feed account AS SEEN INSIDE THE EPHEMERAL ROLLUP
/// (where open/close/force_close actually execute). The ER serves the feed under
/// the Pyth receiver program `PriCe…`; on L1 base devnet the same account is
/// owned by the delegation program `DELe…` because it is delegated to the ER.
/// Since read_fresh runs IN-ROLLUP, this MUST be the ER-side owner.
/// (Verified live: `getAccountInfo` on devnet.magicblock.app reports this owner.)
pub const EXPECTED_FEED_OWNER: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");

/// The 32-byte Pyth feed_id of BTC/USD, decoded from the live PriceUpdateV2.
/// Used to assert the decoded message really is the BTC feed (belt-and-braces;
/// the address pin already guarantees the account identity).
pub const BTC_FEED_ID: [u8; 32] = [
    0x59, 0x64, 0x2e, 0xc3, 0x90, 0x6a, 0x38, 0xd1, 0x26, 0x7d, 0x4a, 0xaf, 0xac, 0x36, 0xa5, 0xe2,
    0xa4, 0x7e, 0x6d, 0x38, 0xed, 0x7e, 0x5b, 0x58, 0x43, 0xdd, 0x28, 0x7e, 0x5e, 0x21, 0xab, 0x65,
];

// ---------------------------------------------------------------------------
// Minimal Pyth PriceUpdateV2 deserialiser (verbatim from the spike).
//
// Layout (after 8-byte discriminator):
//   write_authority : 32 bytes (Pubkey)
//   verification_level : 1 byte (enum tag)
//     Partial { num_signatures: u8 } = tag 0, 1 byte payload
//     Full                           = tag 1, 0 bytes payload
//   price_message :
//     feed_id       : [u8; 32]
//     price         : i64  (8 bytes)
//     conf          : u64  (8 bytes)
//     exponent      : i32  (4 bytes)
//     publish_time  : i64  (8 bytes)
//     prev_publish_time : i64 (8 bytes)
//     ema_price     : i64  (8 bytes)
//     ema_conf      : u64  (8 bytes)
//   posted_slot : u64  (8 bytes)
// ---------------------------------------------------------------------------

/// Minimal parsed subset we actually need.
pub struct PriceSnapshot {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub exponent: i32,
    pub publish_time: i64,
}

pub fn parse_price_update(data: &[u8]) -> Result<PriceSnapshot> {
    // Skip 8-byte Anchor discriminator
    let mut offset: usize = 8;

    let advance = |off: &mut usize, n: usize| -> Result<usize> {
        let start = *off;
        *off = off
            .checked_add(n)
            .ok_or(error!(ErrorCode::AccountNotInitialized))?;
        if *off > data.len() {
            return Err(error!(ErrorCode::AccountNotInitialized));
        }
        Ok(start)
    };

    // write_authority (32)
    advance(&mut offset, 32)?;

    // verification_level (enum tag u8)
    let tag_start = advance(&mut offset, 1)?;
    let tag = data[tag_start];
    if tag == 0 {
        // Partial { num_signatures: u8 }
        advance(&mut offset, 1)?;
    }
    // tag == 1 → Full, no extra bytes

    // price_message.feed_id [u8; 32]
    let s = advance(&mut offset, 32)?;
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&data[s..s + 32]);

    // price i64
    let s = advance(&mut offset, 8)?;
    let price = i64::from_le_bytes(data[s..s + 8].try_into().unwrap());

    // conf u64
    advance(&mut offset, 8)?;

    // exponent i32
    let s = advance(&mut offset, 4)?;
    let exponent = i32::from_le_bytes(data[s..s + 4].try_into().unwrap());

    // publish_time i64
    let s = advance(&mut offset, 8)?;
    let publish_time = i64::from_le_bytes(data[s..s + 8].try_into().unwrap());

    Ok(PriceSnapshot {
        feed_id,
        price,
        exponent,
        publish_time,
    })
}

/// Decode the price account and authenticate it before trusting the price.
/// Used by open/close/force_close so a round can NEVER settle against a forged
/// or frozen feed.
///
/// Defense-in-depth layered behind the `#[account(address = BTC_FEED)]` pin:
///   1. owner — the account must be owned by the real Pyth feed program (as
///      served inside the ER), so a same-pubkey lookalike at a different owner
///      is rejected.
///   2. staleness (both bounds) — reject prices older than STALE_SECS AND
///      prices dated in the future (a forged/clock-skewed publish_time).
///   3. feed_id — the decoded message must be the BTC/USD feed, not some other
///      Pyth feed smuggled in.
pub fn read_fresh(price_acct: &AccountInfo, now_ts: i64) -> Result<PriceSnapshot> {
    // (1) The account must be owned by the trusted feed program.
    require!(
        price_acct.owner == &EXPECTED_FEED_OWNER,
        RaiderError::UntrustedFeed
    );

    let data = price_acct.data.borrow();
    let snap = parse_price_update(&data)?;

    // (2) Staleness — lower bound (frozen feed) AND upper bound (future-dated).
    require!(
        now_ts - snap.publish_time <= crate::state::STALE_SECS,
        RaiderError::StalePrice
    );
    require!(
        snap.publish_time <= now_ts + crate::state::STALE_SECS,
        RaiderError::StalePrice
    );

    // (3) The decoded message must be the BTC/USD feed.
    require!(snap.feed_id == BTC_FEED_ID, RaiderError::UntrustedFeed);

    Ok(snap)
}
