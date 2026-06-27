use anchor_lang::prelude::*;

declare_id!("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");

pub mod settle;

// ===========================================================================
// PROVEN PLUMBING PATTERN — Task 2 (two-account co-delegation), GREEN on devnet
// ---------------------------------------------------------------------------
// Two independently-seeded PDAs were co-delegated to the same MagicBlock ER,
// mutated together in ONE in-rollup instruction, and committed + undelegated
// ATOMICALLY so both updated values landed on L1 (sum conserved). This is the
// player<->house value-movement topology every downstream task depends on.
// The throwaway counter PDAs were removed per the plan; the pattern below is
// the reference for Tasks 6 (delegate_session) / 8 (close) / 10 (commit).
//
//   use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
//   use ephemeral_rollups_sdk::cpi::DelegateConfig;
//   use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
//
//   // Program module is annotated `#[ephemeral]` (before `#[program]`).
//
//   // Co-delegate N PDAs in ONE instruction. The `#[delegate]` macro generates
//   // one `delegate_<field>` method per field tagged `del` and injects the
//   // shared owner_program / delegation_program / system_program plus per-field
//   // buffer / delegation_record / delegation_metadata accounts:
//   pub fn delegate_session(ctx: Context<DelegateSession>) -> Result<()> {
//       let validator = ctx.remaining_accounts.first().map(|a| a.key());
//       ctx.accounts.delegate_player(&ctx.accounts.payer, &[PLAYER_SEED, ..],
//           DelegateConfig { validator, ..Default::default() })?;
//       ctx.accounts.delegate_house(&ctx.accounts.payer, &[HOUSE_SEED, ..],
//           DelegateConfig { validator, ..Default::default() })?;
//       // ...delegate_round(...) etc.
//       Ok(())
//   }
//   #[delegate] #[derive(Accounts)]
//   pub struct DelegateSession<'info> {
//       #[account(mut)] pub payer: Signer<'info>,
//       /// CHECK: delegated PDA
//       #[account(mut, del, seeds = [PLAYER_SEED, ..], bump)] pub player: AccountInfo<'info>,
//       /// CHECK: delegated PDA
//       #[account(mut, del, seeds = [HOUSE_SEED, ..],  bump)] pub house:  AccountInfo<'info>,
//   }
//
//   // Mutate the delegated PDAs together inside the ER in one instruction
//   // (normal `#[account(mut, seeds=..)]` Account<'info, T>), then commit +
//   // undelegate them ATOMICALLY via the bundle builder (`#[commit]` context
//   // injects magic_context / magic_program):
//   pub fn commit_and_undelegate(ctx: Context<SessionCommit>) -> Result<()> {
//       MagicIntentBundleBuilder::new(
//           ctx.accounts.payer.to_account_info(),
//           ctx.accounts.magic_context.to_account_info(),
//           ctx.accounts.magic_program.to_account_info(),
//       )
//       .commit_and_undelegate(&[
//           ctx.accounts.player.to_account_info(),
//           ctx.accounts.house.to_account_info(),
//           // ...round, etc.
//       ])
//       .build_and_invoke()?;
//       Ok(())
//   }
//
// TS driver: two AnchorProviders (base devnet + https://devnet.magicblock.app);
// pass the validator (MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57) as a single
// remaining account on delegate; poll owner -> DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh.
// (Driver kept at tests/codeleg.ts as the executable proof.)
// ===========================================================================

#[ephemeral_rollups_sdk::anchor::ephemeral]
#[program]
pub mod raider {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping<'info> {
    pub payer: Signer<'info>,
}
