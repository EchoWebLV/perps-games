// crate_roll — the MagicBlock ephemeral-vrf consumer shim for crate pulls.
//
// Two instructions, one PDA. `request_roll` (player signs) CPIs the VRF program;
// MagicBlock's oracle computes + proves; the VRF program verifies the proof and CPIs
// `callback_fulfill_roll`, which may ONLY be invoked by the SCOPED per-program VRF identity
// (enforced by the `address =` constraint on a required Signer). The randomness
// lands raw on the player's RollSlot; the CLIENT maps bytes -> car via the public
// deterministic crate math (provable by recomputation). No funds, no roster,
// no odds live here — blast radius of any bug is "crates fail to open".
//
// NOTE (sdk 0.4.1): the plan targeted sdk 0.3.0's GLOBAL identity path, but 0.3.0/0.3.1 are
// yanked. 0.4.1 (the version raider already pulls) defaults to SCOPED requests: the `#[vrf]`
// macro rewrites the request to a scoped discriminator and the oracle signs the callback with
// `scoped_vrf_identity(&crate::ID)` (a per-program PDA), which this callback validates. Stronger
// than the deprecated global `VRF_PROGRAM_IDENTITY`, same guarantee: only MagicBlock can fulfill.
use anchor_lang::prelude::*;
use solana_keccak_hasher as keccak;
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::instructions::{
    create_request_high_priority_scoped_randomness_ix, RequestRandomnessParams,
};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;

declare_id!("CRoLLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); // replaced by `anchor keys sync` in Task 2

pub const ROLL_SEED: &[u8] = b"roll";

#[program]
pub mod crate_roll {
    use super::*;

    /// Player requests randomness for one crate pull. Bumps the nonce (supersedes any
    /// stale in-flight request) and clears `fulfilled`; the caller_seed binds the VRF
    /// request to (player, nonce) so every pull's randomness is unique and attributable.
    pub fn request_roll(ctx: Context<RequestRoll>) -> Result<()> {
        let slot_acc = &mut ctx.accounts.roll_slot;
        slot_acc.player = ctx.accounts.payer.key();
        slot_acc.nonce = slot_acc.nonce.checked_add(1).expect("nonce overflow");
        slot_acc.fulfilled = false;
        slot_acc.bump = ctx.bumps.roll_slot;

        let seed = keccak::hashv(&[ctx.accounts.payer.key().as_ref(), &slot_acc.nonce.to_le_bytes()]).0;
        let ix = create_request_high_priority_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackFulfillRoll::DISCRIMINATOR.to_vec(),
            caller_seed: seed,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: slot_acc.key(),
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF-program-only callback: store the verified randomness. The `address =`
    /// constraint (scoped per-program identity) on the required signer means no wallet or
    /// other program can fake it.
    pub fn callback_fulfill_roll(ctx: Context<CallbackFulfillRoll>, randomness: [u8; 32]) -> Result<()> {
        let slot_acc = &mut ctx.accounts.roll_slot;
        slot_acc.randomness = randomness;
        slot_acc.fulfilled = true;
        slot_acc.slot = Clock::get()?.slot;
        Ok(())
    }
}

#[vrf]
#[derive(Accounts)]
pub struct RequestRoll<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = RollSlot::SIZE,
        seeds = [ROLL_SEED, payer.key().as_ref()],
        bump,
    )]
    pub roll_slot: Account<'info, RollSlot>,
    /// CHECK: MagicBlock oracle queue (devnet default), validated by address.
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CallbackFulfillRoll<'info> {
    /// The SCOPED per-program VRF identity MUST sign — only MagicBlock's verified oracle path,
    /// issuing for THIS program, can fulfill. (sdk 0.4.1 default; supersedes the deprecated
    /// global `VRF_PROGRAM_IDENTITY`. This is the SDK's documented `scoped_vrf_identity` pattern.)
    #[account(address = ephemeral_vrf_sdk::consts::scoped_vrf_identity(&crate::ID))]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub roll_slot: Account<'info, RollSlot>,
}

/// One in-flight roll per player. A re-request supersedes (higher nonce, fulfilled=false);
/// the client only accepts randomness where `fulfilled && nonce == the one it requested`.
#[account]
pub struct RollSlot {
    pub player: Pubkey,
    pub nonce: u64,
    pub fulfilled: bool,
    pub randomness: [u8; 32],
    pub slot: u64,
    pub bump: u8,
}
impl RollSlot {
    // disc(8) + player(32) + nonce(8) + fulfilled(1) + randomness(32) + slot(8) + bump(1)
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 32 + 8 + 1;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roll_slot_size() {
        assert_eq!(RollSlot::SIZE, 90);
    }
    #[test]
    fn caller_seed_is_unique_per_nonce() {
        let p = Pubkey::new_unique();
        let s1 = keccak::hashv(&[p.as_ref(), &1u64.to_le_bytes()]).0;
        let s2 = keccak::hashv(&[p.as_ref(), &2u64.to_le_bytes()]).0;
        assert_ne!(s1, s2);
    }
}
