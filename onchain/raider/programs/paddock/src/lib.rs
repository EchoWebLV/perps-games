use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("3wz2kwDSGZEfdwing4FucjveWunnpiwoYAnKUAbKRh2S");

pub mod book;
pub mod draw;
pub mod price;
pub mod state;

use state::{Bettor, Book, Ticket};
use state::{BETTOR_SEED, BOOK_SEED, TICKET_SEED, VAULT_SEED};

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
