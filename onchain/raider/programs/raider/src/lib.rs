use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
// Lightweight commit+undelegate CPI (the v0 free function) instead of the
// MagicIntentBundleBuilder: the builder drags in the intent/crypto machinery
// (~+70KB of [u128;512] confidential-transfer weight) we don't use, which pushed
// the .so past the available deploy-buffer SOL. This free function does the same
// schedule-commit-and-undelegate CPI on the three PDAs.
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

declare_id!("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");

pub mod price;
pub mod settle;
pub mod state;

use state::{HouseBalance, PlayerBalance, Round};
use state::{HOUSE_SEED, MAX_ROUND_SECS, PLAYER_SEED, ROUND_SEED, STALE_SECS, VAULT_SEED};

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
        r.banked = 0;
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

    // ---- Task 7: fund the house bankroll (L1, pre-delegation) ---------------

    /// Add real USDC capital to the house bankroll. Transfers `amount` from the
    /// funder's ATA into the same program-owned vault `buy_in` uses, then credits
    /// `house.balance`. Permissionless: adding capital is benign (it only ever
    /// increases the house's free balance, never moves value out).
    ///
    /// MUST run on L1 BEFORE `delegate_session` — once the HouseBalance PDA is
    /// delegated to the ER, L1 can no longer mutate it. Without this, `open`
    /// always rejects with `HouseUndercapitalized` (init_house leaves balance=0).
    pub fn fund_house(ctx: Context<FundHouse>, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.funder_token.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
        )?;
        let house = &mut ctx.accounts.house;
        house.balance = house
            .balance
            .checked_add(amount)
            .ok_or(RaiderError::MathOverflow)?;
        Ok(())
    }

    // ---- Task 7: open a round on the ER -------------------------------------

    /// Open a round inside the ER: snapshot the live Lazer entry price, debit the
    /// player's stake, and PRE-LOCK the house's maximum possible payout so the
    /// house is provably solvent for this round before any price moves.
    pub fn open(ctx: Context<OpenRound>, dir: i8, lev: u32, stake: u64) -> Result<()> {
        require!(
            lev >= settle::RMIN && lev <= settle::RMAX,
            RaiderError::BadLeverage
        );
        require!(dir == 1 || dir == -1, RaiderError::BadLeverage);

        let now = Clock::get()?.unix_timestamp;
        let snap = price::read_fresh(&ctx.accounts.price_update, now)?;
        // entry_raw is a DIVISOR in settle::equity_fp at close — a <= 0 entry would
        // div-by-zero / invert the position. Never store a non-positive entry.
        require!(snap.price > 0, RaiderError::BadPrice);

        // Phase 1: the signing authority must be the player who owns the balance.
        require_keys_eq!(
            ctx.accounts.player.owner,
            ctx.accounts.player_authority.key(),
            RaiderError::NotOwner
        );

        let player = &mut ctx.accounts.player;
        let house = &mut ctx.accounts.house;
        let round = &mut ctx.accounts.round;

        require!(round.status != 1, RaiderError::RoundAlreadyOpen);
        require!(
            player.balance >= stake,
            RaiderError::InsufficientPlayerBalance
        );

        let max_payout = settle::max_payout(stake);
        // House must have at least max_payout in FREE (unlocked) balance.
        require!(
            house.balance.saturating_sub(house.locked) >= max_payout,
            RaiderError::HouseUndercapitalized
        );

        // Move value: stake leaves the player; the house pre-locks the worst case.
        player.balance = player
            .balance
            .checked_sub(stake)
            .ok_or(RaiderError::MathOverflow)?;
        house.locked = house
            .locked
            .checked_add(max_payout)
            .ok_or(RaiderError::MathOverflow)?;

        round.owner = player.owner;
        round.dir = dir;
        round.lev = lev;
        round.stake = stake;
        round.entry_raw = snap.price;
        round.entry_expo = snap.exponent;
        round.entry_ts = snap.publish_time;
        round.banked = 0;
        round.max_payout = max_payout;
        round.deadline_ts = now + MAX_ROUND_SECS;
        round.status = 1;
        // Clear any stale settlement record from a previous round on this PDA.
        round.exit_raw = 0;
        round.exit_ts = 0;
        round.payout = 0;
        round.outcome = 0;

        emit!(RoundEvent {
            owner: round.owner,
            kind: 0,
            price_raw: snap.price,
            ts: snap.publish_time,
            banked: 0,
            dir,
            lev,
            equity_fp: settle::SCALE,
            outcome: 0,
            payout: 0,
        });
        Ok(())
    }

    // ---- Task 8: close a round on the ER ------------------------------------

    /// Close the open round at the live Lazer exit price: settle with the
    /// fixed-point engine, credit the player, and conserve value across the
    /// player+house ledgers (the 5% edge stays inside the house-favorable
    /// payout). The settlement record is written into the Round so the result
    /// is deterministically recomputable from on-chain data alone.
    pub fn close(ctx: Context<CloseRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let snap = price::read_fresh(&ctx.accounts.price_update, now)?;

        // Phase 1: only the owner closes their own round (force_close below is the
        // permissionless time-bounded variant).
        require_keys_eq!(
            ctx.accounts.player.owner,
            ctx.accounts.player_authority.key(),
            RaiderError::NotOwner
        );

        settle_round(
            &mut ctx.accounts.player,
            &mut ctx.accounts.house,
            &mut ctx.accounts.round,
            &snap,
            now,
        )
    }

    // ---- Task 9: permissionless time-bounded force_close ---------------------

    /// Liveness backstop: ANY signer can settle a round once it has passed its
    /// `deadline_ts`. Same settle + conserve + store body as `close` (it calls
    /// the shared `settle_round`), but it intentionally OMITS the
    /// `player.owner == authority` check and instead REQUIRES the deadline has
    /// elapsed. This guarantees a stalled or abandoned round can always be
    /// unwound by anyone, releasing the house lock and crediting the player —
    /// no round can escrow the house's capital forever.
    pub fn force_close(ctx: Context<ForceCloseRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let snap = price::read_fresh(&ctx.accounts.price_update, now)?;

        let round = &ctx.accounts.round;
        require!(round.status == 1, RaiderError::NoOpenRound);
        // The ONLY gate: the round must have outlived its liveness deadline.
        require!(now >= round.deadline_ts, RaiderError::NotYetExpired);

        settle_round(
            &mut ctx.accounts.player,
            &mut ctx.accounts.house,
            &mut ctx.accounts.round,
            &snap,
            now,
        )
    }

    // ---- Phase 2: permissionless continuous settler (tick) ------------------

    /// Continuous settler. PERMISSIONLESS heartbeat the keeper/crank calls each
    /// tick: settle ONLY if a terminal (liq/cap) or the 60s time-cap fires at the
    /// live authenticated price; otherwise a no-op. The program reads the price and
    /// renders the verdict, so the trigger can NEVER choose an outcome.
    pub fn tick(ctx: Context<ForceCloseRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let snap = price::read_fresh(&ctx.accounts.price_update, now)?;

        require!(ctx.accounts.round.status == 1, RaiderError::NoOpenRound);

        let fires = settle::fires(
            ctx.accounts.round.banked,
            ctx.accounts.round.dir,
            ctx.accounts.round.lev,
            ctx.accounts.round.entry_raw,
            snap.price,
            now,
            ctx.accounts.round.deadline_ts,
        );
        if !fires {
            return Ok(()); // heartbeat: nothing crossed, leave the round open
        }

        settle_round(
            &mut ctx.accounts.player,
            &mut ctx.accounts.house,
            &mut ctx.accounts.round,
            &snap,
            now,
        )
    }

    // ---- Task 10: commit + undelegate the session back to L1 ----------------

    /// Commit the final state of all three co-delegated PDAs (Player, House,
    /// Round) and undelegate them back to L1 atomically. After this lands, the
    /// settled balances are durable on devnet base layer and `withdraw` can pull
    /// real USDC against the player's restored on-L1 play balance.
    pub fn commit_and_undelegate(ctx: Context<SessionCommit>) -> Result<()> {
        let payer = ctx.accounts.payer.to_account_info();
        let magic_context = ctx.accounts.magic_context.to_account_info();
        let magic_program = ctx.accounts.magic_program.to_account_info();
        let player_ai = ctx.accounts.player.to_account_info();
        let house_ai = ctx.accounts.house.to_account_info();
        let round_ai = ctx.accounts.round.to_account_info();

        // None for magic_fee_vault: our payer is the session signer, NOT a
        // delegated ephemeral balance account, so no commit-fee collection is
        // needed (per the v0 doc comment, None is valid in that case).
        commit_and_undelegate_accounts(
            &payer,
            vec![&player_ai, &house_ai, &round_ai],
            &magic_context,
            &magic_program,
            None,
        )?;
        Ok(())
    }
}

/// Shared settle body for `close` and `force_close`: settle at the given mark,
/// conserve value across player + house (the 5% edge stays house-favorable
/// inside the payout), release the house lock, write the self-contained
/// provable-fairness record into the Round, and emit a RoundEvent. The caller
/// is responsible for any authorization gate (owner check for `close`, deadline
/// check for `force_close`).
fn settle_round(
    player: &mut Account<PlayerBalance>,
    house: &mut Account<HouseBalance>,
    round: &mut Account<Round>,
    snap: &price::PriceSnapshot,
    now: i64,
) -> Result<()> {
    require!(round.status == 1, RaiderError::NoOpenRound);

    let (mut outcome, payout) = settle::settle(
        round.banked,
        round.dir,
        round.lev,
        round.stake,
        round.entry_raw,
        snap.price,
    );
    // Defense in depth: a settle can never exceed the pre-locked worst case.
    let payout = payout.min(round.max_payout);
    // Precedence liq > cap > time > cashout: relabel a plain cashout to Time once
    // the 60s cap has elapsed (payout is the same current-equity cashout).
    if outcome == settle::Outcome::Cashout && now >= round.deadline_ts {
        outcome = settle::Outcome::Time;
    }

    // Value movement (conserved across player + house; edge stays house-side):
    player.balance = player
        .balance
        .checked_add(payout)
        .ok_or(RaiderError::MathOverflow)?;
    house.balance = house
        .balance
        .checked_add(round.stake)
        .ok_or(RaiderError::MathOverflow)?
        .checked_sub(payout)
        .ok_or(RaiderError::MathOverflow)?;
    house.locked = house
        .locked
        .checked_sub(round.max_payout)
        .ok_or(RaiderError::MathOverflow)?;

    // Self-contained provable-fairness record (before flipping to settled).
    round.exit_raw = snap.price;
    round.exit_ts = snap.publish_time;
    round.payout = payout;
    round.outcome = outcome.code();
    round.status = 2;

    emit!(RoundEvent {
        owner: round.owner,
        kind: 3,
        price_raw: snap.price,
        ts: snap.publish_time,
        banked: round.banked,
        dir: round.dir,
        lev: round.lev,
        // equity_fp is recomputed here because settle::settle() computes equity internally then discards it.
        equity_fp: settle::equity_fp(round.banked, round.dir, round.lev, round.entry_raw, snap.price),
        outcome: outcome.code(),
        payout,
    });
    Ok(())
}

// Silence "unused" on STALE_SECS — it is consumed inside price::read_fresh.
#[allow(dead_code)]
const _STALE_SECS_USED: i64 = STALE_SECS;

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

#[derive(Accounts)]
pub struct FundHouse<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [HOUSE_SEED, mint.key().as_ref()],
        bump = house.bump,
    )]
    pub house: Account<'info, HouseBalance>,
    #[account(
        mut,
        constraint = funder_token.mint == mint.key() @ RaiderError::BadPrice,
        constraint = funder_token.owner == funder.key() @ RaiderError::NotOwner,
    )]
    pub funder_token: Account<'info, TokenAccount>,
    #[account(
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
}

// open/close mutate the three CO-DELEGATED ledger PDAs together inside the ER.
// Per the Task-2 proven pattern they are declared as NORMAL `Account<'info, T>`
// (the `del`/AccountInfo form is ONLY for the delegate context) — Anchor
// re-serializes them and `commit_and_undelegate` lands the new state on L1.
#[derive(Accounts)]
pub struct OpenRound<'info> {
    #[account(
        mut,
        seeds = [PLAYER_SEED, player.owner.as_ref(), mint.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, PlayerBalance>,
    #[account(
        mut,
        seeds = [HOUSE_SEED, mint.key().as_ref()],
        bump = house.bump,
    )]
    pub house: Account<'info, HouseBalance>,
    #[account(
        mut,
        seeds = [ROUND_SEED, player.owner.as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,
    pub mint: Account<'info, Mint>,
    /// CHECK: pinned to the Lazer BTC feed (address = BTC_FEED); the bytes are
    /// further authenticated (owner + feed_id + staleness) by price::read_fresh().
    #[account(address = price::BTC_FEED)]
    pub price_update: AccountInfo<'info>,
    // Phase 1 = the owner; session-key-ready slot for later phases.
    pub player_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(
        mut,
        seeds = [PLAYER_SEED, player.owner.as_ref(), mint.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, PlayerBalance>,
    #[account(
        mut,
        seeds = [HOUSE_SEED, mint.key().as_ref()],
        bump = house.bump,
    )]
    pub house: Account<'info, HouseBalance>,
    #[account(
        mut,
        seeds = [ROUND_SEED, player.owner.as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,
    pub mint: Account<'info, Mint>,
    /// CHECK: pinned to the Lazer BTC feed (address = BTC_FEED); the bytes are
    /// further authenticated (owner + feed_id + staleness) by price::read_fresh().
    #[account(address = price::BTC_FEED)]
    pub price_update: AccountInfo<'info>,
    pub player_authority: Signer<'info>,
}

// force_close has the SAME account shape as close EXCEPT the signer carries no
// ownership constraint — `caller` is ANY Signer. The Player PDA is re-derived
// from `player.owner` (the stored value), NOT from the signer, so a stranger
// can settle the round but cannot redirect funds: payout is credited to the
// round owner's PlayerBalance regardless of who calls. The deadline gate in the
// instruction body is what authorizes the call.
#[derive(Accounts)]
pub struct ForceCloseRound<'info> {
    #[account(
        mut,
        seeds = [PLAYER_SEED, player.owner.as_ref(), mint.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, PlayerBalance>,
    #[account(
        mut,
        seeds = [HOUSE_SEED, mint.key().as_ref()],
        bump = house.bump,
    )]
    pub house: Account<'info, HouseBalance>,
    #[account(
        mut,
        seeds = [ROUND_SEED, player.owner.as_ref()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,
    pub mint: Account<'info, Mint>,
    /// CHECK: pinned to the Lazer BTC feed (address = BTC_FEED); the bytes are
    /// further authenticated (owner + feed_id + staleness) by price::read_fresh().
    /// This pin matters most here: force_close is permissionless, so without it
    /// any abandoned round would be drainable via a forged feed.
    #[account(address = price::BTC_FEED)]
    pub price_update: AccountInfo<'info>,
    // Permissionless: any signer (no owner constraint) — the deadline is the gate.
    pub caller: Signer<'info>,
}

// commit_and_undelegate lands the three co-delegated ledger PDAs' final ER state
// back on L1 and returns ownership to the program. The `#[commit]` macro injects
// the magic_context / magic_program accounts the bundle builder needs.
#[commit]
#[derive(Accounts)]
pub struct SessionCommit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PLAYER_SEED, player.owner.as_ref(), mint.key().as_ref()], bump = player.bump)]
    pub player: Account<'info, PlayerBalance>,
    #[account(mut, seeds = [HOUSE_SEED, mint.key().as_ref()], bump = house.bump)]
    pub house: Account<'info, HouseBalance>,
    #[account(mut, seeds = [ROUND_SEED, player.owner.as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    pub mint: Account<'info, Mint>,
}

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
    /// The price account is not the trusted Pyth Lazer BTC feed (wrong owner
    /// program or wrong decoded feed_id) — defense-in-depth behind the address pin.
    UntrustedFeed,
    /// flip got a direction that is not +1 or -1.
    BadDirection,
}

/// Emitted on every Round state transition so the entire path is reconstructable
/// from chain history (final committed Round + this event stream = provable trail).
/// kind: 0 open, 1 flip, 2 lever, 3 settle. price_raw/ts come from the authenticated
/// Lazer read. For kind 0/1/2, banked/dir/lev are the values AFTER the transition;
/// for kind 3 (settle) they are the final realized-segment values at close (settle
/// does not mutate the position). outcome/payout are valid only when kind == 3.
#[event]
pub struct RoundEvent {
    pub owner: Pubkey,
    pub kind: u8,
    pub price_raw: i64,
    pub ts: i64,
    pub banked: i128,
    pub dir: i8,
    pub lev: u32,
    pub equity_fp: i128,
    pub outcome: u8, // valid when kind == 3
    pub payout: u64, // valid when kind == 3
}
