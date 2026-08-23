// vrf-signer-probe — THROWAWAY SPIKE.
//
// ONE binary question:
//   Can a NO-SIGNER, scheduler-executed instruction issue a MagicBlock
//   `ephemeral-vrf` RequestRandomness in-rollup, by `invoke_signed`-ing with the
//   program's identity PDA (seeds [b"identity"]) supplied as BOTH `payer` and
//   `program_identity`?
//
// The ephemeral-vrf program requires (program/src/request_randomness.rs):
//   signer_info.is_signer()?                                   <- payer  = slot 0
//   program_identity_info.has_seeds([IDENTITY], cb_prog)?.is_signer()?  <- slot 1
// Neither check inspects the owner or the lamports, and `fees.rs` exempts
// DEFAULT_EPHEMERAL_QUEUE from the lamport transfer unconditionally, so a
// lamport-less, non-existent PDA should in theory satisfy both. Untested. This
// spike tests it.
//
// TWO request variants, so a failure can be attributed:
//   request_w  — SDK-default metas: payer meta is WRITABLE + signer. Needs the
//                identity PDA declared `mut` in the outer ctx (else runtime
//                PrivilegeEscalation), and needs the ER to accept a WRITABLE,
//                UNDELEGATED, non-existent account.
//   request_ro — payer meta forced READ-ONLY + signer. Legal because the
//                fee-exempt path never debits. Identity declared read-only, so
//                the ER never sees a writable undelegated account.
//
// Both are NO-SIGNER contexts (no `Signer` field at all), reproducing paddock's
// `RaceCrank`, and both are armed through `ScheduleTask` exactly as
// `schedule_race_crank` does.
//
// The VRF CPI result is CAUGHT, not propagated: a callee-returned error (e.g.
// MissingRequiredSignature from the signer checks) leaves the outer instruction
// free to record the code on the probe account, which is observable by polling
// even when the caller is the scheduler and we never see its logs. Runtime-level
// rejections (PrivilegeEscalation, non-writable account) are NOT catchable and
// abort the whole transaction — which is itself a distinguishable signal.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_vrf_sdk::consts::IDENTITY;
use ephemeral_vrf_sdk::instructions::{
    create_request_high_priority_scoped_randomness_ix, RequestRandomnessParams,
};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;

declare_id!("DPRXzxfKbh4ht1jr28QSnZ5XTavqhA6PrH9fuDT7HFJs");

pub const PROBE_SEED: &[u8] = b"probe";
/// Echoed through `callback_args` to settle the callback-arg ORDERING question:
/// if the callback receives tag == 0xA5 with a plausible randomness, then the
/// VRF program appends args AFTER the 32 randomness bytes.
pub const TAG: u8 = 0xA5;

#[ephemeral_rollups_sdk::anchor::ephemeral]
#[program]
pub mod vrf_signer_probe {
    use super::*;

    pub fn init_probe(ctx: Context<InitProbe>) -> Result<()> {
        let p = &mut ctx.accounts.probe;
        p.bump = ctx.bumps.probe;
        p.identity_bump = Pubkey::find_program_address(&[IDENTITY], &crate::ID).1;
        msg!(
            "probe {} identity {} bump {}",
            p.key(),
            Pubkey::find_program_address(&[IDENTITY], &crate::ID).0,
            p.identity_bump
        );
        Ok(())
    }

    pub fn delegate_probe(ctx: Context<DelegateProbe>) -> Result<()> {
        let validator = ctx.remaining_accounts.first().map(|a| a.key());
        ctx.accounts.delegate_probe(
            &ctx.accounts.payer,
            &[PROBE_SEED],
            DelegateConfig { validator, ..Default::default() },
        )?;
        Ok(())
    }

    /// Fallback lever: materialise the identity PDA as a REAL program-owned
    /// account so it can be delegated, in case the ER refuses a writable,
    /// non-existent, undelegated account. Not needed if `request_ro` works.
    pub fn init_identity(ctx: Context<InitIdentity>) -> Result<()> {
        ctx.accounts.program_identity.bump = ctx.bumps.program_identity;
        Ok(())
    }

    pub fn delegate_identity(ctx: Context<DelegateIdentity>) -> Result<()> {
        let validator = ctx.remaining_accounts.first().map(|a| a.key());
        ctx.accounts.delegate_program_identity(
            &ctx.accounts.payer,
            &[IDENTITY],
            DelegateConfig { validator, ..Default::default() },
        )?;
        Ok(())
    }

    /// VARIANT W — NO SIGNER. Identity PDA as both payer (WRITABLE+signer) and
    /// program_identity (readonly+signer). Exactly the proposed escape.
    pub fn request_w(ctx: Context<RequestW>) -> Result<()> {
        let identity = ctx.accounts.program_identity.key();
        let queue = ctx.accounts.oracle_queue.key();
        let probe_key = ctx.accounts.probe.key();
        let nonce = ctx.accounts.probe.attempts;
        let identity_bump = ctx.accounts.probe.identity_bump;

        let ix = build_request(identity, queue, probe_key, nonce, false);
        msg!(
            "request_w: payer meta w={} s={} identity meta w={} s={}",
            ix.accounts[0].is_writable,
            ix.accounts[0].is_signer,
            ix.accounts[1].is_writable,
            ix.accounts[1].is_signer
        );

        let infos = [
            ctx.accounts.program_identity.to_account_info(),
            ctx.accounts.oracle_queue.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.slot_hashes.to_account_info(),
        ];
        let res = invoke_signed(&ix, &infos, &[&[IDENTITY, &[identity_bump]]]);
        record(&mut ctx.accounts.probe, res, 1)
    }

    /// VARIANT RO — NO SIGNER, and the payer meta is forced READ-ONLY. Legal on
    /// the fee-exempt ephemeral queue: `request_randomness.rs` only calls
    /// `signer_info.is_signer()`, never `is_writable()`, and the lamport
    /// transfer is skipped for DEFAULT_EPHEMERAL_QUEUE.
    pub fn request_ro(ctx: Context<RequestRo>) -> Result<()> {
        let identity = ctx.accounts.program_identity.key();
        let queue = ctx.accounts.oracle_queue.key();
        let probe_key = ctx.accounts.probe.key();
        let nonce = ctx.accounts.probe.attempts;
        let identity_bump = ctx.accounts.probe.identity_bump;

        let ix = build_request(identity, queue, probe_key, nonce, true);
        msg!(
            "request_ro: payer meta w={} s={} identity meta w={} s={}",
            ix.accounts[0].is_writable,
            ix.accounts[0].is_signer,
            ix.accounts[1].is_writable,
            ix.accounts[1].is_signer
        );

        let infos = [
            ctx.accounts.program_identity.to_account_info(),
            ctx.accounts.oracle_queue.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.slot_hashes.to_account_info(),
        ];
        let res = invoke_signed(&ix, &infos, &[&[IDENTITY, &[identity_bump]]]);
        record(&mut ctx.accounts.probe, res, 2)
    }

    /// The VRF program's callback. Data layout it builds
    /// (program/src/provide_randomness.rs): discriminator || randomness[32] ||
    /// callback_args. `tag` therefore lands AFTER `randomness`.
    pub fn callback_probe(
        ctx: Context<CallbackProbe>,
        randomness: [u8; 32],
        tag: u8,
    ) -> Result<()> {
        let p = &mut ctx.accounts.probe;
        p.fulfilled = p.fulfilled.saturating_add(1);
        p.randomness = randomness;
        p.tag = tag;
        p.slot = Clock::get()?.slot;
        msg!("callback_probe: tag={} slot={} rnd0={}", tag, p.slot, randomness[0]);
        Ok(())
    }

    /// Arm `request_w` on the native scheduler. `program_identity` is `mut` here
    /// so the scheduled WRITABLE meta inherits write privilege (paddock's note:
    /// otherwise the scheduler rejects the task with PrivilegeEscalation).
    pub fn schedule_w(
        ctx: Context<ScheduleW>,
        task_id: i64,
        execution_interval_millis: i64,
        iterations: i64,
    ) -> Result<()> {
        let metas = vec![
            AccountMeta::new(ctx.accounts.probe.key(), false),
            AccountMeta::new(ctx.accounts.program_identity.key(), false), // WRITABLE
            AccountMeta::new(ctx.accounts.oracle_queue.key(), false),
            AccountMeta::new_readonly(ctx.accounts.vrf_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.slot_hashes.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ];
        let inner = Instruction {
            program_id: crate::ID,
            accounts: metas.clone(),
            data: anchor_lang::InstructionData::data(&crate::instruction::RequestW {}),
        };
        do_schedule(
            &ctx.accounts.payer,
            &[
                ctx.accounts.probe.to_account_info(),
                ctx.accounts.program_identity.to_account_info(),
                ctx.accounts.oracle_queue.to_account_info(),
                ctx.accounts.vrf_program.to_account_info(),
                ctx.accounts.slot_hashes.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            metas,
            inner,
            task_id,
            execution_interval_millis,
            iterations,
        )
    }

    /// Arm `request_ro`. `program_identity` stays READ-ONLY end to end, so the
    /// ER never has to accept a writable undelegated account.
    pub fn schedule_ro(
        ctx: Context<ScheduleRo>,
        task_id: i64,
        execution_interval_millis: i64,
        iterations: i64,
    ) -> Result<()> {
        let metas = vec![
            AccountMeta::new(ctx.accounts.probe.key(), false),
            AccountMeta::new_readonly(ctx.accounts.program_identity.key(), false), // READ-ONLY
            AccountMeta::new(ctx.accounts.oracle_queue.key(), false),
            AccountMeta::new_readonly(ctx.accounts.vrf_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.slot_hashes.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ];
        let inner = Instruction {
            program_id: crate::ID,
            accounts: metas.clone(),
            data: anchor_lang::InstructionData::data(&crate::instruction::RequestRo {}),
        };
        do_schedule(
            &ctx.accounts.payer,
            &[
                ctx.accounts.probe.to_account_info(),
                ctx.accounts.program_identity.to_account_info(),
                ctx.accounts.oracle_queue.to_account_info(),
                ctx.accounts.vrf_program.to_account_info(),
                ctx.accounts.slot_hashes.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            metas,
            inner,
            task_id,
            execution_interval_millis,
            iterations,
        )
    }
}

// ---------------------------------------------------------------- helpers ---

/// Build the scoped high-priority RequestRandomness ix with `identity` in the
/// payer slot. `force_readonly_payer` downgrades meta 0 to read-only.
fn build_request(
    identity: Pubkey,
    queue: Pubkey,
    probe: Pubkey,
    nonce: u64,
    force_readonly_payer: bool,
) -> Instruction {
    let mut seed = [0u8; 32];
    seed[..8].copy_from_slice(&nonce.to_le_bytes());
    seed[8..16].copy_from_slice(&Clock::get().map(|c| c.slot).unwrap_or(0).to_le_bytes());

    let mut ix = create_request_high_priority_scoped_randomness_ix(RequestRandomnessParams {
        payer: identity,
        oracle_queue: queue,
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::CallbackProbe::DISCRIMINATOR.to_vec(),
        caller_seed: seed,
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: probe,
            is_signer: false,
            is_writable: true,
        }]),
        callback_args: Some(vec![TAG]),
    });
    if force_readonly_payer {
        ix.accounts[0].is_writable = false;
    }
    ix
}

/// Record the CPI outcome instead of propagating it, so a scheduler-driven run
/// leaves an observable trace even on failure.
fn record(
    probe: &mut Account<Probe>,
    res: std::result::Result<(), ProgramError>,
    variant: u8,
) -> Result<()> {
    probe.attempts = probe.attempts.saturating_add(1);
    probe.last_variant = variant;
    match res {
        Ok(()) => {
            probe.ok = probe.ok.saturating_add(1);
            probe.last_err = 0;
            msg!("VRF REQUEST OK (variant {})", variant);
        }
        Err(e) => {
            probe.failures = probe.failures.saturating_add(1);
            let code = u64::from(e.clone());
            probe.last_err = code;
            msg!("VRF REQUEST FAILED (variant {}): {:?} code {}", variant, e, code);
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn do_schedule<'info>(
    payer: &Signer<'info>,
    infos: &[AccountInfo<'info>],
    mut metas: Vec<AccountMeta>,
    inner: Instruction,
    task_id: i64,
    execution_interval_millis: i64,
    iterations: i64,
) -> Result<()> {
    let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
        task_id,
        execution_interval_millis,
        iterations,
        instructions: vec![inner],
    }))
    .map_err(|err| {
        msg!("ERROR: failed to serialize ScheduleTask args {:?}", err);
        ProgramError::InvalidArgument
    })?;

    // The outer ScheduleTask ix must carry every scheduled account with at least
    // the privilege the scheduled meta asks for, plus the signing payer.
    let mut outer = vec![AccountMeta::new(payer.key(), true)];
    outer.append(&mut metas);

    let schedule_ix = Instruction::new_with_bytes(MAGIC_PROGRAM_ID, &ix_data, outer);

    let mut all = vec![payer.to_account_info()];
    all.extend_from_slice(infos);
    invoke_signed(&schedule_ix, &all, &[])?;

    msg!(
        "scheduled task {} interval {}ms x{}",
        task_id, execution_interval_millis, iterations
    );
    Ok(())
}

// ---------------------------------------------------------------- accounts ---

#[derive(Accounts)]
pub struct InitProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = Probe::SIZE, seeds = [PROBE_SEED], bump)]
    pub probe: Account<'info, Probe>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateProbe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the probe PDA being delegated
    #[account(mut, del, seeds = [PROBE_SEED], bump)]
    pub probe: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct InitIdentity<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = Identity::SIZE, seeds = [IDENTITY], bump)]
    pub program_identity: Account<'info, Identity>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateIdentity<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the identity PDA being delegated
    #[account(mut, del, seeds = [IDENTITY], bump)]
    pub program_identity: AccountInfo<'info>,
}

// NO Signer field — the exact shape of paddock's RaceCrank.
#[derive(Accounts)]
pub struct RequestW<'info> {
    #[account(mut, seeds = [PROBE_SEED], bump = probe.bump)]
    pub probe: Account<'info, Probe>,
    /// CHECK: the program identity PDA. WRITABLE here so the CPI may ask for a
    /// writable payer meta without tripping runtime PrivilegeEscalation.
    #[account(mut, seeds = [IDENTITY], bump = probe.identity_bump)]
    pub program_identity: UncheckedAccount<'info>,
    /// CHECK: MagicBlock in-rollup oracle queue, pinned by address.
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
    /// CHECK: the ephemeral-vrf program, CPI target.
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID)]
    pub vrf_program: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar.
    #[account(address = ephemeral_vrf_sdk::compat::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// Same shape, identity READ-ONLY.
#[derive(Accounts)]
pub struct RequestRo<'info> {
    #[account(mut, seeds = [PROBE_SEED], bump = probe.bump)]
    pub probe: Account<'info, Probe>,
    /// CHECK: the program identity PDA, read-only.
    #[account(seeds = [IDENTITY], bump = probe.identity_bump)]
    pub program_identity: UncheckedAccount<'info>,
    /// CHECK: MagicBlock in-rollup oracle queue, pinned by address.
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
    /// CHECK: the ephemeral-vrf program, CPI target.
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID)]
    pub vrf_program: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar.
    #[account(address = ephemeral_vrf_sdk::compat::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CallbackProbe<'info> {
    /// The SCOPED per-program VRF identity must sign — same guard crate-roll uses.
    #[account(address = ephemeral_vrf_sdk::consts::scoped_vrf_identity(&crate::ID))]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub probe: Account<'info, Probe>,
}

#[derive(Accounts)]
pub struct ScheduleW<'info> {
    /// CHECK: the Magic program, ScheduleTask CPI target
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PROBE_SEED], bump = probe.bump)]
    pub probe: Account<'info, Probe>,
    /// CHECK: identity PDA, `mut` so the scheduled writable meta inherits write privilege
    #[account(mut, seeds = [IDENTITY], bump = probe.identity_bump)]
    pub program_identity: UncheckedAccount<'info>,
    /// CHECK: in-rollup oracle queue
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
    /// CHECK: ephemeral-vrf program
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID)]
    pub vrf_program: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar
    #[account(address = ephemeral_vrf_sdk::compat::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ScheduleRo<'info> {
    /// CHECK: the Magic program, ScheduleTask CPI target
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PROBE_SEED], bump = probe.bump)]
    pub probe: Account<'info, Probe>,
    /// CHECK: identity PDA, read-only throughout
    #[account(seeds = [IDENTITY], bump = probe.identity_bump)]
    pub program_identity: UncheckedAccount<'info>,
    /// CHECK: in-rollup oracle queue
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
    /// CHECK: ephemeral-vrf program
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_ID)]
    pub vrf_program: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar
    #[account(address = ephemeral_vrf_sdk::compat::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ------------------------------------------------------------------- state ---

#[account]
pub struct Probe {
    pub bump: u8,
    pub identity_bump: u8,
    pub last_variant: u8,
    pub attempts: u64,
    pub ok: u64,
    pub failures: u64,
    pub last_err: u64,
    pub fulfilled: u64,
    pub randomness: [u8; 32],
    pub tag: u8,
    pub slot: u64,
}
impl Probe {
    // disc 8 + 3 u8 + 5 u64 (40) + 32 + 1 + 8
    pub const SIZE: usize = 8 + 3 + 40 + 32 + 1 + 8;
}

#[account]
pub struct Identity {
    pub bump: u8,
}
impl Identity {
    pub const SIZE: usize = 8 + 1;
}
