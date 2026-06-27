use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("A1JfNBqRKHmrU5XuHP1vHNKoQfhEqR25MtWvdD6u8dbV");

pub const PROBE_SEED: &[u8] = b"probe";

// ---------------------------------------------------------------------------
// Minimal Pyth PriceUpdateV2 deserialiser
//
// Mirrors the on-chain layout of pyth-solana-receiver-sdk's PriceUpdateV2
// without dragging that crate in (it conflicts with ephemeral-rollups-sdk
// over bytemuck_derive versions).  Layout (after 8-byte discriminator):
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
struct PriceSnapshot {
    price: i64,
    exponent: i32,
    publish_time: i64,
}

fn parse_price_update(data: &[u8]) -> Result<PriceSnapshot> {
    // Skip 8-byte Anchor discriminator
    let mut offset: usize = 8;

    let advance = |off: &mut usize, n: usize| -> Result<usize> {
        let start = *off;
        *off = off.checked_add(n).ok_or(error!(ErrorCode::AccountNotInitialized))?;
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

// ---------------------------------------------------------------------------
// On-chain state
// ---------------------------------------------------------------------------

#[account]
pub struct Probe {
    pub last_price: i64,
    pub last_expo: i32,
    pub last_ts: i64,
    pub tick_count: u64,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[ephemeral]
#[program]
pub mod lazer_probe {
    use super::*;

    /// Create the Probe PDA and zero-initialise it.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.last_price = 0;
        probe.last_expo = 0;
        probe.last_ts = 0;
        probe.tick_count = 0;
        Ok(())
    }

    /// Read a Pyth Lazer price feed account (passed as AccountInfo) and write
    /// price/expo/publish_time into Probe, then increment tick_count.
    /// Will run on the ER once delegated; this instruction just needs to compile.
    pub fn sample(ctx: Context<Sample>) -> Result<()> {
        let data = ctx.accounts.price_update.data.borrow();
        let snap = parse_price_update(&data)?;

        let probe = &mut ctx.accounts.probe;
        probe.last_price = snap.price;
        probe.last_expo = snap.exponent;
        probe.last_ts = snap.publish_time;
        probe.tick_count = probe.tick_count.saturating_add(1);

        msg!(
            "sample: price={} expo={} ts={} ticks={}",
            probe.last_price,
            probe.last_expo,
            probe.last_ts,
            probe.tick_count,
        );
        Ok(())
    }

    /// Delegate the Probe PDA to the Ephemeral Rollup.
    pub fn delegate(ctx: Context<DelegateProbe>) -> Result<()> {
        ctx.accounts.delegate_probe(
            &ctx.accounts.payer,
            &[PROBE_SEED],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|a| a.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Commit Probe state and undelegate it back to L1.
    pub fn commit_and_undelegate(ctx: Context<ProbeCommit>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.probe.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + 8 + 4 + 8 + 8,
        seeds = [PROBE_SEED],
        bump
    )]
    pub probe: Account<'info, Probe>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sample<'info> {
    #[account(mut, seeds = [PROBE_SEED], bump)]
    pub probe: Account<'info, Probe>,
    /// CHECK: Pyth Lazer price feed account; validated by parse_price_update()
    pub price_update: AccountInfo<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The Probe PDA to delegate
    #[account(mut, del, seeds = [PROBE_SEED], bump)]
    pub probe: AccountInfo<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct ProbeCommit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PROBE_SEED], bump)]
    pub probe: Account<'info, Probe>,
}
