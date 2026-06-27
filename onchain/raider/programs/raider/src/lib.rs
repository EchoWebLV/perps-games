use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

declare_id!("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");

pub mod price;
pub mod settle;
pub mod state;

use state::{HouseBalance, PlayerBalance, Round};
use state::{HOUSE_SEED, MAX_ROUND_SECS, PLAYER_SEED, ROUND_SEED, VAULT_SEED};

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

    // ---- Task 4: house init -------------------------------------------------

    /// Create the shared HouseBalance ledger PDA + the program-owned vault token
    /// account (ATA of the `[b"vault", mint]` authority PDA) that custodies real USDC.
    pub fn init_house(ctx: Context<InitHouse>) -> Result<()> {
        let h = &mut ctx.accounts.house;
        h.authority = ctx.accounts.authority.key();
        h.mint = ctx.accounts.mint.key();
        h.balance = 0;
        h.locked = 0;
        h.bump = ctx.bumps.house;
        Ok(())
    }

    // ---- Task 5: deposit / withdraw ----------------------------------------

    /// Deposit real USDC: transfer `amount` from the owner's ATA into the vault,
    /// then credit the owner's play balance. Non-custodial: funds only ever move
    /// owner -> vault here, and back out via owner-only `withdraw`.
    pub fn buy_in(ctx: Context<BuyIn>, amount: u64) -> Result<()> {
        // Real USDC owner -> vault, authorised by the owner's own signature.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_token.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        let player = &mut ctx.accounts.player;
        // first-init fields (init_if_needed leaves them zeroed on first use)
        player.owner = ctx.accounts.owner.key();
        player.mint = ctx.accounts.mint.key();
        player.bump = ctx.bumps.player;
        player.balance = player
            .balance
            .checked_add(amount)
            .ok_or(RaiderError::MathOverflow)?;
        Ok(())
    }

    /// Owner-only withdraw of play balance back to real USDC.
    ///
    /// NON-CUSTODIAL INVARIANT: `player` is re-derived from the SIGNER's pubkey
    /// (seeds `[b"player", owner, mint]`), so a non-owner signing this instruction
    /// derives a DIFFERENT PDA than the victim's and the `seeds`/`has_one` Anchor
    /// constraints reject the call. The explicit `require_keys_eq!` is belt-and-braces.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let player = &mut ctx.accounts.player;
        require_keys_eq!(
            player.owner,
            ctx.accounts.owner.key(),
            RaiderError::NotOwner
        );
        require!(
            player.balance >= amount,
            RaiderError::InsufficientPlayerBalance
        );
        player.balance -= amount;

        let mint = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[VAULT_SEED, mint.as_ref(), &[ctx.bumps.vault_authority]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    // ---- Task 6: round init + co-delegation --------------------------------

    /// Create the per-player Round PDA `[b"round", owner]` in the idle state so it
    /// can be co-delegated to the ER alongside Player + House before `open`.
    pub fn init_round(ctx: Context<InitRound>) -> Result<()> {
        let r = &mut ctx.accounts.round;
        r.owner = ctx.accounts.owner.key();
        r.dir = 0;
        r.lev = 0;
        r.stake = 0;
        r.entry_raw = 0;
        r.entry_expo = 0;
        r.entry_ts = 0;
        r.max_payout = 0;
        r.deadline_ts = 0;
        r.status = 0; // idle
        r.bump = ctx.bumps.round;
        Ok(())
    }

    /// Co-delegate Player + House + Round to the MagicBlock ER in one instruction.
    /// The validator is passed as the single remaining account (Task-2 proven).
    pub fn delegate_session(ctx: Context<DelegateSession>) -> Result<()> {
        let owner = ctx.accounts.payer.key();
        let mint = ctx.accounts.mint.key();
        let validator = ctx.remaining_accounts.first().map(|a| a.key());

        ctx.accounts.delegate_player(
            &ctx.accounts.payer,
            &[PLAYER_SEED, owner.as_ref(), mint.as_ref()],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        ctx.accounts.delegate_house(
            &ctx.accounts.payer,
            &[HOUSE_SEED, mint.as_ref()],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        ctx.accounts.delegate_round(
            &ctx.accounts.payer,
            &[ROUND_SEED, owner.as_ref()],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }
}

// ===========================================================================
// Account contexts
// ===========================================================================

#[derive(Accounts)]
pub struct InitHouse<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = HouseBalance::SIZE,
        seeds = [HOUSE_SEED, mint.key().as_ref()],
        bump
    )]
    pub house: Account<'info, HouseBalance>,
    /// CHECK: PDA that owns the vault token account; only used as a signing authority.
    #[account(seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyIn<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = owner,
        space = PlayerBalance::SIZE,
        seeds = [PLAYER_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub player: Account<'info, PlayerBalance>,
    #[account(
        mut,
        constraint = owner_token.mint == mint.key() @ RaiderError::BadPrice,
        constraint = owner_token.owner == owner.key() @ RaiderError::NotOwner,
    )]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump,
    )]
    /// CHECK: vault authority PDA (token account owner)
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    // Re-derived from the SIGNER (owner) — a non-owner derives a different PDA.
    #[account(
        mut,
        seeds = [PLAYER_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump = player.bump,
        has_one = owner @ RaiderError::NotOwner,
    )]
    pub player: Account<'info, PlayerBalance>,
    #[account(
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump,
    )]
    /// CHECK: vault authority PDA (token account owner / CPI signer)
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority,
    )]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_token.mint == mint.key() @ RaiderError::BadPrice,
    )]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitRound<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = Round::SIZE,
        seeds = [ROUND_SEED, owner.key().as_ref()],
        bump
    )]
    pub round: Account<'info, Round>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    /// CHECK: PlayerBalance PDA to delegate
    #[account(
        mut,
        del,
        seeds = [PLAYER_SEED, payer.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub player: AccountInfo<'info>,
    /// CHECK: HouseBalance PDA to delegate
    #[account(mut, del, seeds = [HOUSE_SEED, mint.key().as_ref()], bump)]
    pub house: AccountInfo<'info>,
    /// CHECK: Round PDA to delegate
    #[account(mut, del, seeds = [ROUND_SEED, payer.key().as_ref()], bump)]
    pub round: AccountInfo<'info>,
}

// Silence "unused" on the liveness backstop constant until `open` (Task 7) lands.
#[allow(dead_code)]
const _MAX_ROUND_SECS_USED: i64 = MAX_ROUND_SECS;

#[error_code]
pub enum RaiderError {
    StalePrice,
    BadPrice,
    RoundAlreadyOpen,
    NoOpenRound,
    InsufficientPlayerBalance,
    HouseUndercapitalized,
    BadLeverage,
    NotOwner,
    NotYetExpired,
    MathOverflow,
}
