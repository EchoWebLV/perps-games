use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

declare_id!("3wz2kwDSGZEfdwing4FucjveWunnpiwoYAnKUAbKRh2S");

pub mod book;
pub mod draw;
pub mod price;
pub mod state;

use state::{Bettor, Book, Race, Ticket};
use state::{BETTOR_SEED, BOOK_SEED, RACE_SEED, TICKET_SEED, VAULT_SEED};

#[ephemeral_rollups_sdk::anchor::ephemeral]
#[program]
pub mod paddock {
    use super::*;

    /// Create the book ledger + the program-owned vault ATA that custodies stakes.
    pub fn init_book(ctx: Context<InitBook>) -> Result<()> {
        let b = &mut ctx.accounts.book;
        b.authority = ctx.accounts.authority.key();
        b.mint = ctx.accounts.mint.key();
        b.balance = 0;
        b.locked = 0;
        b.bump = ctx.bumps.book;
        Ok(())
    }

    /// Create the per-player ledger + ticket. Both are delegated together later.
    pub fn join(ctx: Context<Join>) -> Result<()> {
        let b = &mut ctx.accounts.bettor;
        b.owner = ctx.accounts.payer.key();
        b.mint = ctx.accounts.mint.key();
        b.balance = 0;
        b.bump = ctx.bumps.bettor;

        let t = &mut ctx.accounts.ticket;
        t.owner = ctx.accounts.payer.key();
        t.race_seq = u64::MAX; // sentinel: belongs to no race yet
        t.stakes = [0; state::GRID];
        t.bump = ctx.bumps.ticket;
        Ok(())
    }

    /// Move real tokens into the vault and credit play balance. L1 only.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
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
        let b = &mut ctx.accounts.bettor;
        b.balance = b.balance.checked_add(amount).ok_or(PaddockError::MathOverflow)?;
        Ok(())
    }

    /// Pull tokens back out against the restored play balance. L1 only, and only
    /// after the Bettor PDA has been committed + undelegated.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let b = &mut ctx.accounts.bettor;
        require!(b.balance >= amount, PaddockError::InsufficientBalance);
        b.balance -= amount;

        let mint_key = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[VAULT_SEED, mint_key.as_ref(), &[ctx.bumps.vault_authority]];
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

    /// Create the singleton Race, idle and un-delegated, so it can be delegated.
    /// `entrants` and `strengths` seed the first grid; the crank re-rolls them
    /// each cycle.
    pub fn init_race(
        ctx: Context<InitRace>,
        entrants: [u8; state::GRID],
        strengths: [u16; state::GRID],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.race;
        r.mint = ctx.accounts.mint.key();
        r.seq = 0;
        r.phase = state::PHASE_MARKET;
        r.phase_ends_ts = now + state::MARKET_SECS;
        r.entrants = entrants;
        r.strengths = strengths;
        r.pools = [0; state::GRID];
        r.total = 0;
        r.order = [0; state::GRID];
        r.seed = [0; 32];
        r.feed = ctx.accounts.price_update.key();
        r.rake_accrued = 0;
        r.history = [state::RaceResult::default(); state::HISTORY_LEN];
        r.bump = ctx.bumps.race;
        Ok(())
    }

    /// Delegate the singleton Race. Permissionless, runs ONCE for the lifetime of
    /// the book. Validator is the single remaining account (raider's proven shape,
    /// programs/raider/src/lib.rs:231).
    pub fn delegate_race(ctx: Context<DelegateRace>) -> Result<()> {
        let mint = ctx.accounts.mint.key();
        let validator = ctx.remaining_accounts.first().map(|a| a.key());
        ctx.accounts.delegate_race(
            &ctx.accounts.payer,
            &[RACE_SEED, mint.as_ref()],
            DelegateConfig { validator, ..Default::default() },
        )?;
        Ok(())
    }

    /// Co-delegate ONE player's Bettor + Ticket. Runs once per player, ever.
    /// MUST name the same validator as `delegate_race` or the two cannot be
    /// written in the same ER transaction.
    pub fn delegate_bettor(ctx: Context<DelegateBettor>) -> Result<()> {
        let owner = ctx.accounts.payer.key();
        let mint = ctx.accounts.mint.key();
        let validator = ctx.remaining_accounts.first().map(|a| a.key());
        ctx.accounts.delegate_bettor(
            &ctx.accounts.payer,
            &[BETTOR_SEED, owner.as_ref(), mint.as_ref()],
            DelegateConfig { validator, ..Default::default() },
        )?;
        ctx.accounts.delegate_ticket(
            &ctx.accounts.payer,
            &[TICKET_SEED, owner.as_ref(), mint.as_ref()],
            DelegateConfig { validator, ..Default::default() },
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitBook<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = authority, space = Book::SIZE,
              seeds = [BOOK_SEED, mint.key().as_ref()], bump)]
    pub book: Account<'info, Book>,
    /// CHECK: vault authority PDA (owns the vault ATA)
    #[account(seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(init, payer = authority, associated_token::mint = mint,
              associated_token::authority = vault_authority)]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Join<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = payer, space = Bettor::SIZE,
              seeds = [BETTOR_SEED, payer.key().as_ref(), mint.key().as_ref()], bump)]
    pub bettor: Account<'info, Bettor>,
    #[account(init, payer = payer, space = Ticket::SIZE,
              seeds = [TICKET_SEED, payer.key().as_ref(), mint.key().as_ref()], bump)]
    pub ticket: Account<'info, Ticket>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [BETTOR_SEED, owner.key().as_ref(), mint.key().as_ref()],
              bump = bettor.bump)]
    pub bettor: Account<'info, Bettor>,
    #[account(mut,
        constraint = owner_token.mint == mint.key() @ PaddockError::BadMint,
        constraint = owner_token.owner == owner.key() @ PaddockError::NotOwner)]
    pub owner_token: Account<'info, TokenAccount>,
    /// CHECK: vault authority PDA
    #[account(seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = mint,
              associated_token::authority = vault_authority)]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut,
        constraint = bettor.owner == owner.key() @ PaddockError::NotOwner,
        seeds = [BETTOR_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump = bettor.bump)]
    pub bettor: Account<'info, Bettor>,
    #[account(mut,
        constraint = owner_token.mint == mint.key() @ PaddockError::BadMint,
        constraint = owner_token.owner == owner.key() @ PaddockError::NotOwner)]
    pub owner_token: Account<'info, TokenAccount>,
    /// CHECK: vault authority PDA
    #[account(seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = mint,
              associated_token::authority = vault_authority)]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitRace<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = authority, space = Race::SIZE,
              seeds = [RACE_SEED, mint.key().as_ref()], bump)]
    pub race: Account<'info, Race>,
    /// CHECK: the Lazer price account this book races on. Authenticated at lock
    /// by price::read_fresh; pinned into race.feed here.
    pub price_update: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateRace<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    /// CHECK: Race PDA to delegate
    #[account(mut, del, seeds = [RACE_SEED, mint.key().as_ref()], bump)]
    pub race: AccountInfo<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateBettor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    /// CHECK: Bettor PDA to delegate
    #[account(mut, del, seeds = [BETTOR_SEED, payer.key().as_ref(), mint.key().as_ref()], bump)]
    pub bettor: AccountInfo<'info>,
    /// CHECK: Ticket PDA to delegate
    #[account(mut, del, seeds = [TICKET_SEED, payer.key().as_ref(), mint.key().as_ref()], bump)]
    pub ticket: AccountInfo<'info>,
}

#[error_code]
pub enum PaddockError {
    StalePrice,
    UntrustedFeed,
    BadMint,
    NotOwner,
    InsufficientBalance,
    MathOverflow,
    WrongPhase,
    BadCarIndex,
    NoSuchResult,
    AlreadyClaimed,
}
