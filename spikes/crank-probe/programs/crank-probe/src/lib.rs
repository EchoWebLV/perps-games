// Task 8 crank-probe spike: GREEN/RED gate for native ScheduleTask on the
// public devnet MagicBlock ER validator MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57.
//
// A tiny program with a Counter PDA, an `increment` ix, and a `schedule_increment`
// ix that CPIs MagicBlockInstruction::ScheduleTask through the SDK's
// `ScheduleCrankCpi`. The scheduled instruction is this program's OWN `increment`
// bound to the Counter PDA; once delegated, the ER validator is supposed to
// auto-invoke it every `execution_interval_millis` for `iterations` runs with NO
// client tx. The driver verifies the counter advances during a pure sleep.
//
// Mirrors magicblock-labs/magicblock-engine-examples/crank-counter, ported to
// this project's toolchain (anchor 0.32.1, ephemeral-rollups-sdk 0.15.5
// anchor-compat) and the lazer-probe delegate pattern (seeds-based PDA, validator
// passed as the single remaining account).
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;

declare_id!("BoJm14XnRfdGrFNhHfgTxbWNi4JznqvUKtaHDweXfhLE");

pub const COUNTER_SEED: &[u8] = b"counter";

#[account]
pub struct Counter {
    pub value: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ScheduleIncrementArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}

#[ephemeral]
#[program]
pub mod crank_probe {
    use super::*;

    /// Create the Counter PDA and zero it.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.value = 0;
        msg!("counter {} initialized: {}", counter.key(), counter.value);
        Ok(())
    }

    /// Increment the Counter. This is the instruction the validator is supposed
    /// to auto-run on the schedule with NO client tx.
    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.value = counter.value.saturating_add(1);
        msg!("counter {} value: {}", counter.key(), counter.value);
        Ok(())
    }

    /// Delegate the Counter PDA to the Ephemeral Rollup. Validator is passed as
    /// the single remaining account (same pattern as lazer-probe / raider).
    pub fn delegate(ctx: Context<DelegateCounter>) -> Result<()> {
        ctx.accounts.delegate_counter(
            &ctx.accounts.payer,
            &[COUNTER_SEED],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|a| a.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Schedule the validator to auto-invoke `increment` on the Counter every
    /// `execution_interval_millis` ms for `iterations` runs. Runs INSIDE the ER
    /// (the Counter is delegated). The scheduled inner ix is our own `increment`
    /// bound to the Counter PDA; the validator is the executor/signer at run time.
    pub fn schedule_increment(
        ctx: Context<ScheduleIncrement>,
        args: ScheduleIncrementArgs,
    ) -> Result<()> {
        // The scheduled inner instruction: our own `increment` bound to the
        // Counter PDA. The validator becomes the executor at run time.
        let increment_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(ctx.accounts.counter.key(), false)],
            data: anchor_lang::InstructionData::data(&crate::instruction::Increment {}),
        };

        // Build the MagicBlockInstruction::ScheduleTask payload and CPI it to the
        // Magic program. This mirrors the official crank-counter example's direct
        // invoke_signed (the SDK's ScheduleCrankCpi wrapper has awkward borrow
        // lifetimes; the serialization is identical — bincode of the enum).
        let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
            task_id: args.task_id,
            execution_interval_millis: args.execution_interval_millis,
            iterations: args.iterations,
            instructions: vec![increment_ix],
        }))
        .map_err(|err| {
            msg!("ERROR: failed to serialize ScheduleTask args {:?}", err);
            ProgramError::InvalidArgument
        })?;

        let schedule_ix = Instruction::new_with_bytes(
            MAGIC_PROGRAM_ID,
            &ix_data,
            vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.counter.key(), false),
            ],
        );

        invoke_signed(
            &schedule_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.counter.to_account_info(),
            ],
            &[],
        )?;

        msg!(
            "scheduled task {} interval {}ms x{} iterations",
            args.task_id,
            args.execution_interval_millis,
            args.iterations,
        );
        Ok(())
    }

    /// Commit Counter state and undelegate it back to L1.
    pub fn commit_and_undelegate(ctx: Context<CounterCommit>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.counter.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + 8,
        seeds = [COUNTER_SEED],
        bump
    )]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: Account<'info, Counter>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The Counter PDA to delegate
    #[account(mut, del, seeds = [COUNTER_SEED], bump)]
    pub counter: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ScheduleIncrement<'info> {
    /// CHECK: the Magic program, used for CPI
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Counter PDA passed to the CPI; UncheckedAccount avoids Anchor
    /// re-serializing stale data after the CPI.
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CounterCommit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: Account<'info, Counter>,
}
