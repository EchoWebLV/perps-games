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
    advance(&mut offset, 32)?;

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
        price,
        exponent,
        publish_time,
    })
}

/// Decode the price account and reject anything older than STALE_SECS. Used by
/// open/close so a round never settles against a frozen feed.
pub fn read_fresh(price_acct: &AccountInfo, now_ts: i64) -> Result<PriceSnapshot> {
    let data = price_acct.data.borrow();
    let snap = parse_price_update(&data)?;
    require!(
        now_ts - snap.publish_time <= crate::state::STALE_SECS,
        RaiderError::StalePrice
    );
    Ok(snap)
}
