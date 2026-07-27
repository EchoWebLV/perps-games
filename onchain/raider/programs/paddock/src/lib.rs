use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;

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
    pub fn init_book(ctx: Context<InitBook>, validator: Pubkey) -> Result<()> {
        let b = &mut ctx.accounts.book;
        b.authority = ctx.accounts.authority.key();
        b.mint = ctx.accounts.mint.key();
        b.validator = validator;
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
        // The validator MUST match the one pinned at init_book, or this account
        // lands in a different rollup from the rest of the book's state and can
        // never be co-written. Enforced on-chain, not by client convention.
        let validator = ctx.remaining_accounts.first().map(|a| a.key());
        require!(
            validator == Some(ctx.accounts.book.validator),
            PaddockError::ValidatorMismatch
        );
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
        // The validator MUST match the one pinned at init_book, or this account
        // lands in a different rollup from the rest of the book's state and can
        // never be co-written. Enforced on-chain, not by client convention.
        let validator = ctx.remaining_accounts.first().map(|a| a.key());
        require!(
            validator == Some(ctx.accounts.book.validator),
            PaddockError::ValidatorMismatch
        );
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

    /// Place a bet on `car_id` in the live race. ER only.
    ///
    /// If the ticket belongs to an older race, its winnings are auto-credited from
    /// the history ring FIRST, then the stakes are zeroed and the ticket adopts the
    /// current seq. That mirrors the round-corpse reconciliation in
    /// redline3d/src/chain/game-session.ts:385 and means the common path never
    /// needs an explicit `claim`.
    pub fn place_bet(ctx: Context<PlaceBet>, car_id: u8, amount: u64) -> Result<()> {
        let race = &mut ctx.accounts.race;
        let ticket = &mut ctx.accounts.ticket;
        let bettor = &mut ctx.accounts.bettor;

        require!(race.phase == state::PHASE_MARKET, PaddockError::WrongPhase);
        require!((car_id as usize) < state::GRID, PaddockError::BadCarIndex);

        // Reconcile a stale ticket BEFORE the affordability check, so winnings
        // already owed are spendable in the same call. Checking first would
        // reject bets the player can actually afford.
        if ticket.race_seq != race.seq {
            let credit = settle_ticket(race, ticket);
            if credit > 0 {
                bettor.balance = bettor
                    .balance
                    .checked_add(credit)
                    .ok_or(PaddockError::MathOverflow)?;
            }
            ticket.stakes = [0; state::GRID];
            ticket.race_seq = race.seq;
        }

        require!(bettor.balance >= amount, PaddockError::InsufficientBalance);
        bettor.balance -= amount;

        ticket.stakes[car_id as usize] = ticket.stakes[car_id as usize]
            .checked_add(amount)
            .ok_or(PaddockError::MathOverflow)?;
        race.pools[car_id as usize] = race.pools[car_id as usize]
            .checked_add(amount)
            .ok_or(PaddockError::MathOverflow)?;
        race.total = race.total.checked_add(amount).ok_or(PaddockError::MathOverflow)?;
        Ok(())
    }

    /// The whole race state machine. NO SIGNER — this is the instruction the
    /// MagicBlock validator auto-executes, the no-signer twin of raider's
    /// `tick_crank` (programs/raider/src/lib.rs:593). No-ops when the current
    /// phase has not expired, so leftover scheduled iterations are harmless.
    pub fn race_crank(ctx: Context<RaceCrank>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let race = &mut ctx.accounts.race;

        if now < race.phase_ends_ts {
            return Ok(());
        }

        match race.phase {
            state::PHASE_MARKET => {
                // LOCK. The seed does not exist until this instant, so the winner
                // cannot be known while bets are open. Seed and phase flip land in
                // the SAME instruction — a bet can never follow the seed.
                let snap = price::read_fresh(&ctx.accounts.price_update, now)?;

                // ---- ANTI-GRINDING GATE ----------------------------------
                // race_crank has NO signer (the MagicBlock scheduler executes it
                // with every meta is_signer: false), so it is permissionless:
                // anyone may fire it, not just the validator. Without this gate
                // the submitter effectively CHOOSES the entropy, because
                // race_seed/draw_order are pure public functions and read_fresh
                // accepts any price within STALE_SECS (30s) — dozens of free
                // rolls, enough to land a chosen winner near-certainly.
                //
                // Constrain the seed to a price published in a narrow band at the
                // COMMITTED lock time. The scheduled crank runs every ~1s and
                // takes the first in-band price, so an attacker is reduced from
                // grinding the whole staleness window to racing the honest crank
                // within a single slot.
                //
                // This narrows the exposure; it does not remove it. The real fix
                // is VRF, where the output cannot be steered by submission
                // timing at all. Tracked as a follow-up.
                if snap.publish_time < race.phase_ends_ts {
                    // Price predates the committed lock instant. Wait for a
                    // fresher one rather than seeding from a stale sample.
                    return Ok(());
                }
                let gap = snap.publish_time - race.phase_ends_ts;
                if gap > state::LOCK_WINDOW_SECS {
                    // No price landed in the band — a feed stall, or no crank got
                    // through in time. Slide the target to the band that actually
                    // contains the current price instead of WIDENING the band,
                    // since a wider band is precisely the grinding surface being
                    // closed here. Bands tile contiguously, so every price falls
                    // in exactly one and liveness is preserved.
                    race.phase_ends_ts += (gap / state::LOCK_WINDOW_SECS)
                        * state::LOCK_WINDOW_SECS;
                    return Ok(());
                }
                // ----------------------------------------------------------

                race.seed = draw::race_seed(race.seq, snap.price, snap.publish_time);
                race.order = draw::draw_order(&race.seed, &race.strengths);
                race.phase = state::PHASE_RACING;
                race.phase_ends_ts = now + state::RACE_SECS;
            }
            state::PHASE_RACING => {
                let winner = race.order[0];
                let s = book::settle_pool(race.total, race.pools[winner as usize]);
                race.rake_accrued = race
                    .rake_accrued
                    .checked_add(s.rake)
                    .ok_or(PaddockError::MathOverflow)?;
                // Hoisted out of the call: `push_result` takes `&mut self` through
                // Account's DerefMut, and that reservation isn't two-phase across
                // the coercion, so reading `race.seq` inline in the struct literal
                // argument conflicts with it (E0502). Pre-read the Copy field instead.
                let seq = race.seq;
                race.push_result(state::RaceResult {
                    seq,
                    winner,
                    mult_fp: s.mult_fp,
                });
                race.phase = state::PHASE_SETTLED;
                race.phase_ends_ts = now + state::FINISH_SECS;
            }
            state::PHASE_SETTLED => {
                // Roll to the next race. Shuffle the grid so slot assignment is not
                // static, then zero the betting state.
                let next = race.seq + 1;
                let grid_seed = draw::race_seed(next, 0, 0);
                let p = draw::draw_order(&grid_seed, &race.strengths);

                // CORRECTION to the original plan: `entrants` and `strengths` MUST
                // be permuted TOGETHER. `strengths[i]` is the strength of whichever
                // car sits in slot i, and `pools[i]`/`ticket.stakes[i]` are indexed
                // by that same slot. Permuting entrants alone would leave slot i
                // showing a different car while keeping the previous car's strength,
                // silently detaching the odds from the cars they describe.
                let old_entrants = race.entrants;
                let old_strengths = race.strengths;
                for i in 0..state::GRID {
                    race.entrants[i] = old_entrants[p[i] as usize];
                    race.strengths[i] = old_strengths[p[i] as usize];
                }

                race.seq = next;
                race.pools = [0; state::GRID];
                race.total = 0;
                race.order = [0; state::GRID];
                race.seed = [0; 32];
                race.phase = state::PHASE_MARKET;
                race.phase_ends_ts = now + state::MARKET_SECS;
            }
            _ => {}
        }
        Ok(())
    }

    /// Explicit payout for a player who does not bet again. The common path is
    /// covered by the auto-settle inside `place_bet`.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let race = &ctx.accounts.race;
        let ticket = &mut ctx.accounts.ticket;
        let bettor = &mut ctx.accounts.bettor;

        require!(ticket.race_seq != u64::MAX, PaddockError::NoSuchResult);
        require!(ticket.race_seq != race.seq, PaddockError::WrongPhase);

        let credit = settle_ticket(race, ticket);
        ticket.stakes = [0; state::GRID];
        ticket.race_seq = u64::MAX;
        if credit > 0 {
            bettor.balance = bettor
                .balance
                .checked_add(credit)
                .ok_or(PaddockError::MathOverflow)?;
        }
        Ok(())
    }

    /// Land the Race's ER state on L1 WITHOUT undelegating. Permissionless.
    ///
    /// Race is permanently delegated, so raider's commit-once-at-session-end
    /// model does not apply — without a bare commit, the history ring and the
    /// rake counter would never reach the base layer at all.
    ///
    /// `rake_accrued` is deliberately NOT zeroed here. It is a CUMULATIVE
    /// counter. The tokens never leave the vault, so zeroing it would erase the
    /// house's claim with nothing credited anywhere, and L1 cannot write it back
    /// down (Book is not delegated, Race is). The L1 sweep that credits
    /// Book.balance against a high-water mark is a separate follow-up.
    ///
    /// Doubles as the audit trail: each commit publishes the history ring to L1.
    pub fn commit_race(ctx: Context<CommitRace>) -> Result<()> {
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.race.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
            None,
        )?;
        Ok(())
    }

    /// Commit + undelegate ONE player's Bettor/Ticket so they can withdraw on L1.
    pub fn exit_bettor(ctx: Context<ExitBettor>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.payer.key(),
            ctx.accounts.bettor.owner,
            PaddockError::NotOwner
        );
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![
                &ctx.accounts.bettor.to_account_info(),
                &ctx.accounts.ticket.to_account_info(),
            ],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
            None,
        )?;
        Ok(())
    }

    /// Arm the native crank: the validator auto-invokes `race_crank` every
    /// `execution_interval_millis` ms for `iterations` runs, with zero client tx.
    /// Byte-identical in construction to raider's `schedule_tick`
    /// (programs/raider/src/lib.rs:614) — only the scheduled inner ix differs.
    pub fn schedule_race_crank(
        ctx: Context<ScheduleRaceCrank>,
        task_id: i64,
        execution_interval_millis: i64,
        iterations: i64,
    ) -> Result<()> {
        let feed = ctx.accounts.race.feed;

        let crank_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.race.key(), false),
                AccountMeta::new_readonly(feed, false),
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::RaceCrank {}),
        };

        let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
            task_id,
            execution_interval_millis,
            iterations,
            instructions: vec![crank_ix],
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
                AccountMeta::new(ctx.accounts.race.key(), false),
                AccountMeta::new_readonly(feed, false),
            ],
        );

        invoke_signed(
            &schedule_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.race.to_account_info(),
                ctx.accounts.price_update.to_account_info(),
            ],
            &[],
        )?;

        msg!(
            "scheduled race_crank task {} interval {}ms x{}",
            task_id, execution_interval_millis, iterations
        );
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
    #[account(
        seeds = [BOOK_SEED, mint.key().as_ref()],
        bump = book.bump,
        has_one = authority @ PaddockError::NotOwner,
    )]
    pub book: Account<'info, Book>,
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
    #[account(seeds = [BOOK_SEED, mint.key().as_ref()], bump = book.bump)]
    pub book: Account<'info, Book>,
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
    #[account(seeds = [BOOK_SEED, mint.key().as_ref()], bump = book.bump)]
    pub book: Account<'info, Book>,
    /// CHECK: Bettor PDA to delegate
    #[account(mut, del, seeds = [BETTOR_SEED, payer.key().as_ref(), mint.key().as_ref()], bump)]
    pub bettor: AccountInfo<'info>,
    /// CHECK: Ticket PDA to delegate
    #[account(mut, del, seeds = [TICKET_SEED, payer.key().as_ref(), mint.key().as_ref()], bump)]
    pub ticket: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [RACE_SEED, mint.key().as_ref()], bump = race.bump)]
    pub race: Account<'info, Race>,
    #[account(mut,
        constraint = bettor.owner == payer.key() @ PaddockError::NotOwner,
        seeds = [BETTOR_SEED, payer.key().as_ref(), mint.key().as_ref()],
        bump = bettor.bump)]
    pub bettor: Account<'info, Bettor>,
    #[account(mut,
        constraint = ticket.owner == payer.key() @ PaddockError::NotOwner,
        seeds = [TICKET_SEED, payer.key().as_ref(), mint.key().as_ref()],
        bump = ticket.bump)]
    pub ticket: Account<'info, Ticket>,
}

// No Signer slot: the validator executes this. The Race PDA is re-derived from
// its stored mint, and the feed is pinned to race.feed, so the crank can only
// ever advance THIS book against THIS feed.
#[derive(Accounts)]
pub struct RaceCrank<'info> {
    #[account(mut, seeds = [RACE_SEED, race.mint.as_ref()], bump = race.bump)]
    pub race: Account<'info, Race>,
    /// CHECK: must equal race.feed. Authenticated by price::read_fresh.
    #[account(constraint = price_update.key() == race.feed @ PaddockError::UntrustedFeed)]
    pub price_update: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(seeds = [RACE_SEED, mint.key().as_ref()], bump = race.bump)]
    pub race: Account<'info, Race>,
    #[account(mut,
        constraint = bettor.owner == payer.key() @ PaddockError::NotOwner,
        seeds = [BETTOR_SEED, payer.key().as_ref(), mint.key().as_ref()],
        bump = bettor.bump)]
    pub bettor: Account<'info, Bettor>,
    #[account(mut,
        constraint = ticket.owner == payer.key() @ PaddockError::NotOwner,
        seeds = [TICKET_SEED, payer.key().as_ref(), mint.key().as_ref()],
        bump = ticket.bump)]
    pub ticket: Account<'info, Ticket>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitRace<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RACE_SEED, race.mint.as_ref()], bump = race.bump)]
    pub race: Account<'info, Race>,
}

#[commit]
#[derive(Accounts)]
pub struct ExitBettor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [BETTOR_SEED, bettor.owner.as_ref(), mint.key().as_ref()],
              bump = bettor.bump)]
    pub bettor: Account<'info, Bettor>,
    #[account(mut, seeds = [TICKET_SEED, ticket.owner.as_ref(), mint.key().as_ref()],
              bump = ticket.bump)]
    pub ticket: Account<'info, Ticket>,
}

// `race` is typed and `mut` for the same reason raider's ScheduleTick does it
// (programs/raider/src/lib.rs:1436): the scheduled writable meta must inherit
// write privilege or the scheduler rejects the task with PrivilegeEscalation.
#[derive(Accounts)]
pub struct ScheduleRaceCrank<'info> {
    /// CHECK: the Magic program, used for the ScheduleTask CPI
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RACE_SEED, race.mint.as_ref()], bump = race.bump)]
    pub race: Account<'info, Race>,
    /// CHECK: must equal race.feed; forwarded into the scheduled metas.
    #[account(constraint = price_update.key() == race.feed @ PaddockError::UntrustedFeed)]
    pub price_update: AccountInfo<'info>,
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
    ValidatorMismatch,
}

/// Payout owed to `ticket` for the race it currently references, or 0 if that
/// race has aged out of the ring, was never settled, or the ticket had no stake
/// on the winner. Idempotent by construction: callers zero `stakes` afterwards.
fn settle_ticket(race: &Race, ticket: &Ticket) -> u64 {
    // Sentinel guard, mandated by the HAZARD note on Race::find_result in
    // state.rs: the history ring is zero-initialised, so an unguarded lookup can
    // match a phantom all-zero RaceResult. A fresh ticket carries u64::MAX.
    if ticket.race_seq == u64::MAX {
        return 0;
    }
    let Some(result) = race.find_result(ticket.race_seq) else {
        return 0;
    };
    book::payout_of(ticket.stakes[result.winner as usize], result.mult_fp)
}
