use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;
// Lightweight commit+undelegate CPI (the v0 free function) instead of the
// MagicIntentBundleBuilder: the builder drags in the intent/crypto machinery
// (~+70KB of [u128;512] confidential-transfer weight) we don't use, which pushed
// the .so past the available deploy-buffer SOL. This free function does the same
// schedule-commit-and-undelegate CPI on the three PDAs.
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

declare_id!("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");

pub mod house;
pub mod price;
pub mod settle;
pub mod state;

use state::{FeedRegistry, HouseBalance, PlayerBalance, Round};
use state::{FEEDS_SEED, HARD_MAX_ROUND_SECS, HOUSE_SEED, MAX_ROUND_SECS, MIN_ROUND_SECS, PLAYER_SEED, ROUND_SEED, STALE_SECS, VAULT_SEED};

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

    // ---- Multi-asset: feed registry (admin, L1) -----------------------------

    /// Create the singleton feed registry. The signer becomes the admin authority.
    pub fn init_feed_registry(ctx: Context<InitFeedRegistry>) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.authority = ctx.accounts.authority.key();
        r.feeds = Default::default();
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Register (or update/disable) the feed for an asset slot. Admin-only.
    pub fn set_feed(
        ctx: Context<SetFeed>,
        asset: u8,
        feed: Pubkey,
        feed_id: [u8; 32],
        enabled: bool,
    ) -> Result<()> {
        require!((asset as usize) < state::MAX_ASSETS, RaiderError::UnknownAsset);
        let r = &mut ctx.accounts.registry;
        r.feeds[asset as usize] = state::FeedEntry { feed, feed_id, enabled };
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
        r.liq_fp = 0; // set at open (clamped to [MIN_LIQ_FP, LIQ_FP]); never read while idle
        r.grace_secs = 0; // Skull grace window; set at open (0 = none)
        r.sl_fp = 0; // Pink Rod stop-loss; set at open (0 = unset)
        r.tp_fp = 0; // Pink Rod take-profit; set at open (0 = unset)
        r.refund_fp = 0; // Flintstone airbag; set at open (0 = none)
        r.status = 0; // idle
        r.bump = ctx.bumps.round;
        r.liq_breach_ts = 0; // Skull grace runtime record; written by the tick
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
            &[HOUSE_SEED, mint.as_ref(), owner.as_ref()],
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

    // ---- House sharding: carve a per-session till off the master pot (L1) -------

    /// Session start (L1, BEFORE delegate_session): carve one worst-case payout
    /// (`slice = max_payout(selected_stake)`, computed by the client) off the master
    /// bankroll `[house, mint]` into this player's per-session till
    /// `[house, mint, owner]`, so the delegated round settles against a till that can
    /// always cover its own payout. The till is then co-delegated to the ER alongside
    /// Player + Round (NOT the master). Self-healing: any leftover already in the till
    /// (a skipped end-sweep, or a delegate that failed after a prior slice) is folded
    /// back into the master first, so re-slicing never double-spends. Rejects with
    /// HouseUndercapitalized when the pot can't cover the slice (the operator's
    /// "bankroll under threshold → not playable" rule, enforced on-chain).
    pub fn slice_from_pot(ctx: Context<SliceFromPot>, slice: u64) -> Result<()> {
        // A till mid-open (locked > 0, e.g. an abandoned round committed to L1) must be
        // force_closed before it can be re-sliced — otherwise reclaiming its balance
        // would strand the open round's lock. Clean tills (settled or fresh) have locked == 0.
        require!(ctx.accounts.till.locked == 0, RaiderError::RoundAlreadyOpen);

        let (new_master, new_till) = house::reclaim_and_slice(
            ctx.accounts.master.balance,
            ctx.accounts.till.balance,
            slice,
        )
        .map_err(|e| match e {
            house::HouseMathError::Undercapitalized => RaiderError::HouseUndercapitalized,
            house::HouseMathError::Overflow => RaiderError::MathOverflow,
        })?;

        ctx.accounts.master.balance = new_master;

        let master_authority = ctx.accounts.master.authority;
        let mint = ctx.accounts.mint.key();
        let till = &mut ctx.accounts.till;
        // init_if_needed zeroes a fresh till; (re)stamp identity + the carved balance.
        till.authority = master_authority;
        till.mint = mint;
        till.balance = new_till;
        till.locked = 0;
        till.bump = ctx.bumps.till;
        Ok(())
    }

    /// Session end (L1, AFTER undelegate): return this player's till balance to the
    /// master bankroll, so losses fund the next player and the freed slice is available
    /// again (the single-pot / self-smoothing property). PERMISSIONLESS: moving a till's
    /// balance into the master can only consolidate value into the pot, never extract it,
    /// so anyone may call it — the player's own client at session end, or a keeper
    /// reclaiming an abandoned session's slice. The till must be fully settled
    /// (locked == 0) and undelegated (program-owned — a live session's delegated till is
    /// owned by the delegation program and fails the typed-account check here).
    pub fn sweep_till(ctx: Context<SweepTill>) -> Result<()> {
        require!(ctx.accounts.till.locked == 0, RaiderError::RoundAlreadyOpen);
        ctx.accounts.master.balance =
            house::sweep(ctx.accounts.master.balance, ctx.accounts.till.balance)
                .map_err(|_| RaiderError::MathOverflow)?;
        ctx.accounts.till.balance = 0;
        Ok(())
    }

    // ---- Task 7: open a round on the ER -------------------------------------

    /// Open a round inside the ER: snapshot the live Lazer entry price, debit the
    /// player's stake, and PRE-LOCK the house's maximum possible payout so the
    /// house is provably solvent for this round before any price moves.
    pub fn open(
        ctx: Context<OpenRound>,
        asset: u8,
        dir: i8,
        lev: u32,
        stake: u64,
        dur: i64,
        liq: u32,
        grace: u16,
        sl: u32,
        tp: u32,
        refund: u32,
    ) -> Result<()> {
        require!(
            lev >= settle::RMIN && lev <= settle::RMAX,
            RaiderError::BadLeverage
        );
        require!(dir == 1 || dir == -1, RaiderError::BadLeverage);
        require!((asset as usize) < state::MAX_ASSETS, RaiderError::UnknownAsset);

        // Registry binds the asset → feed. The passed price_update MUST be the registered,
        // enabled feed for this asset; read_fresh authenticates owner+staleness; the decoded
        // feed_id must match the registered id (defense-in-depth).
        let entry = ctx.accounts.registry.feeds[asset as usize];
        require!(entry.enabled, RaiderError::UnknownAsset);
        require_keys_eq!(ctx.accounts.price_update.key(), entry.feed, RaiderError::UntrustedFeed);

        let now = Clock::get()?.unix_timestamp;
        let snap = price::read_fresh(&ctx.accounts.price_update, now)?;
        require!(snap.feed_id == entry.feed_id, RaiderError::UntrustedFeed);
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
        round.feed = ctx.accounts.price_update.key();
        round.dir = dir;
        round.lev = lev;
        round.stake = stake;
        round.entry_raw = snap.price;
        round.entry_expo = snap.exponent;
        round.entry_ts = snap.publish_time;
        round.banked = 0;
        round.max_payout = max_payout;
        // Round length: the client requests `dur` seconds (the Long-Range Tank upgrade raises it
        // above the base). 0/negative → the default MAX_ROUND_SECS; anything else is clamped into
        // [MIN_ROUND_SECS, HARD_MAX_ROUND_SECS] so a longer round can't be forced past the ceiling.
        // Duration never affects house solvency (max_payout is CAP-bounded, not time-bounded).
        let secs = if dur <= 0 { MAX_ROUND_SECS } else { dur.clamp(MIN_ROUND_SECS, HARD_MAX_ROUND_SECS) };
        round.deadline_ts = now + secs;
        // Liquidation floor: the client requests `liq` in SCALE units (the Suspension upgrade
        // lowers it below the base). 0 → the default 0.20; anything else is clamped into
        // [MIN_LIQ_FP, LIQ_FP] (0.10..0.20) so a client can NEVER push the floor below the
        // Suspension-maxed 0.10 — a lower floor would let a position ride toward zero and drain
        // the house. Stamped on the round → every settle path honors THIS value (provable fairness).
        round.liq_fp = if liq == 0 {
            settle::LIQ_FP as u32
        } else {
            (liq as i128).clamp(settle::MIN_LIQ_FP, settle::LIQ_FP) as u32
        };
        // Skull "Death's Door": grace window in seconds (0 = none). Clamped to
        // MAX_GRACE_SECS so a client can never buy an unbounded survival window (grace is
        // house-negative). Honored only by the permissionless tick/crank.
        round.grace_secs = grace.min(settle::MAX_GRACE_SECS);
        // Pink Rod stop-loss / take-profit (SCALE units; 0 = unset). SL is clamped strictly
        // ABOVE this round's liq floor and below break-even; TP strictly above break-even and
        // below CAP. So a gap through SL to under the floor still liquidates (liq is checked
        // first), and TP can never pre-empt the cap. Both settle as a normal Cashout at the mark.
        round.sl_fp = if sl == 0 {
            0
        } else {
            (sl as i128).clamp(round.liq_fp as i128 + 1, settle::SCALE - 1) as u32
        };
        round.tp_fp = if tp == 0 {
            0
        } else {
            (tp as i128).clamp(settle::SCALE + 1, settle::CAP_FP - 1) as u32
        };
        // Flintstone "Stone-Age Airbag": SCALE-units fraction of stake a liquidation
        // refunds (0 = none, the default for every non-Flintstone car). Clamped to
        // MAX_REFUND_FP (0.20) so a client can never buy back more than floor-level
        // equity — settle::terminal pays min(refund, observed equity) with the standard
        // edge, so it never beats cashing out above the floor. Stamped on the round →
        // every liquidation path honors THIS value (provable fairness).
        round.refund_fp = state::clamp_refund_fp(refund);
        round.status = 1;
        // Clear any stale settlement record from a previous round on this PDA (this Round
        // PDA is reused across rounds without re-init). liq_breach_ts MUST reset too, or a
        // prior grace round's stale breach would make the first sub-floor tick liquidate
        // immediately (as if the whole window had already elapsed).
        round.exit_raw = 0;
        round.exit_ts = 0;
        round.payout = 0;
        round.outcome = 0;
        round.liq_breach_ts = 0;

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
        // Keep the keeper-path error contract: a `tick` on a non-open round errors
        // with NoOpenRound (tests/keeper.ts swallows exactly that). The crank path
        // (`tick_crank`) instead NO-OPs on a settled round so leftover scheduled
        // iterations after a liq are harmless.
        require!(ctx.accounts.round.status == 1, RaiderError::NoOpenRound);
        let now = Clock::get()?.unix_timestamp;
        try_settle_tick(
            &mut ctx.accounts.player,
            &mut ctx.accounts.house,
            &mut ctx.accounts.round,
            &ctx.accounts.price_update,
            now,
        )
    }

    // ---- Task 9: native MagicBlock crank (self-driving tick, zero client tx) ---

    /// The instruction the ER validator auto-runs on the schedule (see
    /// `schedule_tick`). Identical settlement logic to `tick`, but with NO signer:
    /// the validator is the executor at run time, so `CrankClose` carries no
    /// `Signer`. It NO-OPs on a non-open round so leftover scheduled iterations that
    /// fire AFTER the round has already liquidated/settled don't error (the schedule
    /// runs `iterations` times regardless of when the round actually closes).
    pub fn tick_crank(ctx: Context<CrankClose>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        try_settle_tick(
            &mut ctx.accounts.player,
            &mut ctx.accounts.house,
            &mut ctx.accounts.round,
            &ctx.accounts.price_update,
            now,
        )
    }

    /// Arm the native crank: ask the MagicBlock validator to auto-invoke
    /// `tick_crank` on THIS round every `execution_interval_millis` ms for
    /// `iterations` runs, with ZERO further client tx. Runs INSIDE the ER (the three
    /// PDAs are delegated). The scheduled inner ix is the program's own `tick_crank`
    /// bound to this player/house/round/mint/feed; the validator becomes the
    /// executor/signer at run time, funded from the schedule payer's MagicBlock
    /// escrow. Construction is byte-identical to the Task-8 crank-probe spike (a
    /// direct `invoke_signed` of `bincode(MagicBlockInstruction::ScheduleTask)`,
    /// sidestepping the SDK wrapper's borrow-lifetime conflicts) — only the scheduled
    /// inner ix carries raider's 5 accounts instead of the spike's single Counter.
    pub fn schedule_tick(
        ctx: Context<ScheduleTick>,
        task_id: i64,
        execution_interval_millis: i64,
        iterations: i64,
    ) -> Result<()> {
        // The feed this round opened on (bound by the ScheduleTick constraint to
        // equal price_update.key()); forwarded into both scheduled metas so the
        // native crank settles against the round's own asset feed.
        let feed = ctx.accounts.round.feed;

        // The scheduled inner instruction: our own `tick_crank` bound to this
        // round's PDAs. The validator executes/signs it at run time.
        let tick_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.player.key(), false),
                AccountMeta::new(ctx.accounts.house.key(), false),
                AccountMeta::new(ctx.accounts.round.key(), false),
                AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
                AccountMeta::new_readonly(feed, false),
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::TickCrank {}),
        };

        let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
            task_id,
            execution_interval_millis,
            iterations,
            instructions: vec![tick_ix],
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
                AccountMeta::new(ctx.accounts.player.key(), false),
                AccountMeta::new(ctx.accounts.house.key(), false),
                AccountMeta::new(ctx.accounts.round.key(), false),
                AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
                AccountMeta::new_readonly(feed, false),
            ],
        );

        invoke_signed(
            &schedule_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.player.to_account_info(),
                ctx.accounts.house.to_account_info(),
                ctx.accounts.round.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.price_update.to_account_info(),
            ],
            &[],
        )?;

        msg!(
            "scheduled tick task {} interval {}ms x{} iterations",
            task_id,
            execution_interval_millis,
            iterations,
        );
        Ok(())
    }

    // ---- Phase 2: flip direction mid-round ----------------------------------

    /// Reverse direction mid-round (owner-authority). Reads the live authenticated
    /// price; if it already liq/caps or the cap-time has passed, SETTLES instead of
    /// flipping (matches off-chain terminalAt-before-applyAction). Otherwise realizes
    /// the current segment into `banked`, re-anchors `entry_raw`, and reverses `dir`.
    ///
    /// Mirrors the off-chain engine's `applyAction` flip (packages/engine/src/settle.ts:
    /// `case "flip": return { ...rebank(pos, priceRaw), dir }`): rebank the current
    /// segment into `banked`, then set `dir = new_dir`. A SAME-direction `new_dir`
    /// (e.g. `flip(1)` while already long) is a LEGAL re-anchor — it locks the current
    /// segment into `banked` and resets `entry_raw`, NOT an error — matching the engine,
    /// which applies `{ ...rebank(pos), dir }` with no same-direction restriction. It is
    /// conservation-safe (the close payout is still cap-clamped) and equity / liq-distance
    /// neutral at the flip instant: the terminal-first `fires` check settles any real liq
    /// BEFORE re-anchoring, so a re-anchor can never let a position escape a liquidation.
    pub fn flip(ctx: Context<CloseRound>, new_dir: i8) -> Result<()> {
        require!(new_dir == 1 || new_dir == -1, RaiderError::BadDirection);
        let now = Clock::get()?.unix_timestamp;
        let snap = price::read_fresh(&ctx.accounts.price_update, now)?;

        require_keys_eq!(
            ctx.accounts.player.owner,
            ctx.accounts.player_authority.key(),
            RaiderError::NotOwner
        );
        require!(ctx.accounts.round.status == 1, RaiderError::NoOpenRound);

        if settle::fires(
            ctx.accounts.round.banked,
            ctx.accounts.round.dir,
            ctx.accounts.round.lev,
            ctx.accounts.round.entry_raw,
            snap.price,
            now,
            ctx.accounts.round.deadline_ts,
            ctx.accounts.round.liq_fp as i128,
        ) {
            return settle_round(
                &mut ctx.accounts.player,
                &mut ctx.accounts.house,
                &mut ctx.accounts.round,
                &snap,
                now,
            );
        }

        let round = &mut ctx.accounts.round;
        round.banked = settle::rebank_fp(round.banked, round.dir, round.lev, round.entry_raw, snap.price);
        round.entry_raw = snap.price;
        round.entry_expo = snap.exponent;
        round.dir = new_dir;
        emit!(RoundEvent {
            owner: round.owner,
            kind: 1,
            price_raw: snap.price,
            ts: snap.publish_time,
            banked: round.banked,
            dir: round.dir,
            lev: round.lev,
            // entry_raw == snap.price here, so the new-segment term cancels: equity_fp == SCALE + banked (the realized P&L going into the new segment).
            equity_fp: settle::equity_fp(round.banked, round.dir, round.lev, round.entry_raw, snap.price),
            outcome: 0,
            payout: 0,
        });
        Ok(())
    }

    /// Change leverage mid-round (owner-authority). Same terminal-first + rebank as
    /// `flip`, but re-anchors at the new leverage instead of reversing direction.
    ///
    /// A SAME-leverage `new_lev` (e.g. lever(currentLev)) is a LEGAL re-anchor — it
    /// locks the current segment into `banked` and resets `entry_raw`, with `lev`
    /// unchanged — NOT an error. Mirrors the off-chain engine's `applyAction` lever
    /// (packages/engine/src/settle.ts: `{ ...rebank(pos), lev }`, no same-leverage
    /// restriction). It is conservation-safe (the close payout is still cap-clamped)
    /// and equity / liq-distance neutral at the lever instant: the terminal-first
    /// `fires` check settles any real liq BEFORE re-anchoring, so a re-anchor can
    /// never let a position escape a liquidation.
    pub fn lever(ctx: Context<CloseRound>, new_lev: u32) -> Result<()> {
        require!(
            new_lev >= settle::RMIN && new_lev <= settle::RMAX,
            RaiderError::BadLeverage
        );
        let now = Clock::get()?.unix_timestamp;
        let snap = price::read_fresh(&ctx.accounts.price_update, now)?;

        require_keys_eq!(
            ctx.accounts.player.owner,
            ctx.accounts.player_authority.key(),
            RaiderError::NotOwner
        );
        require!(ctx.accounts.round.status == 1, RaiderError::NoOpenRound);

        if settle::fires(
            ctx.accounts.round.banked,
            ctx.accounts.round.dir,
            ctx.accounts.round.lev,
            ctx.accounts.round.entry_raw,
            snap.price,
            now,
            ctx.accounts.round.deadline_ts,
            ctx.accounts.round.liq_fp as i128,
        ) {
            return settle_round(
                &mut ctx.accounts.player,
                &mut ctx.accounts.house,
                &mut ctx.accounts.round,
                &snap,
                now,
            );
        }

        let round = &mut ctx.accounts.round;
        round.banked = settle::rebank_fp(round.banked, round.dir, round.lev, round.entry_raw, snap.price);
        round.entry_raw = snap.price;
        round.entry_expo = snap.exponent;
        round.lev = new_lev;
        emit!(RoundEvent {
            owner: round.owner,
            kind: 2,
            price_raw: snap.price,
            ts: snap.publish_time,
            banked: round.banked,
            dir: round.dir,
            lev: round.lev,
            // entry_raw == snap.price here, so the new-segment term cancels: equity_fp == SCALE + banked.
            equity_fp: settle::equity_fp(round.banked, round.dir, round.lev, round.entry_raw, snap.price),
            outcome: 0,
            payout: 0,
        });
        Ok(())
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

/// Shared continuous-settler body for `tick` (keeper) and `tick_crank` (native
/// crank): read the live authenticated price and settle ONLY if a terminal
/// (liq/cap) or the time-cap fires; otherwise no-op. NO-OPs (returns Ok) on a
/// non-open round so a crank iteration that fires after the round already settled
/// is harmless. The CALLER owns the open-round error contract: `tick` requires
/// status==1 BEFORE calling this (keeper-path NoOpenRound error preserved);
/// `tick_crank` does not (leftover scheduled iterations must not error). Because the
/// program reads the price and renders the verdict, the trigger can NEVER choose an
/// outcome — identical to the pre-Task-9 inline `tick` body.
fn try_settle_tick<'info>(
    player: &mut Account<'info, PlayerBalance>,
    house: &mut Account<'info, HouseBalance>,
    round: &mut Account<'info, Round>,
    price_update: &AccountInfo<'info>,
    now: i64,
) -> Result<()> {
    if round.status != 1 {
        return Ok(()); // not open: no-op (harmless for leftover crank ticks after settle)
    }
    let snap = price::read_fresh(price_update, now)?;
    // tick_action layers the Skull grace window + Pink Rod SL/TP over the plain
    // liq/cap/time terminal check. Stamp/clear write the grace breach timestamp WITHOUT
    // settling (the round rides on); Settle hands off to the shared settle body, which
    // renders the outcome/payout (a grace-elapsed liq or an SL/TP cashout at the mark).
    match settle::tick_action(
        round.banked,
        round.dir,
        round.lev,
        round.entry_raw,
        snap.price,
        now,
        round.deadline_ts,
        round.liq_fp as i128,
        round.grace_secs as i64,
        round.liq_breach_ts,
        round.sl_fp as i128,
        round.tp_fp as i128,
    ) {
        settle::TickAction::Settle => settle_round(player, house, round, &snap, now),
        settle::TickAction::StampBreach => {
            round.liq_breach_ts = now; // enter the Death's-Door window
            Ok(())
        }
        settle::TickAction::ClearBreach => {
            round.liq_breach_ts = 0; // climbed back above the floor → survived
            Ok(())
        }
        settle::TickAction::Hold => Ok(()), // heartbeat / still within grace: leave open
    }
}

/// Shared settle body for `close`, `force_close`, `flip`/`lever` (terminal-first),
/// and the `tick`/`tick_crank` settler (via `try_settle_tick`): settle at the given
/// mark, conserve value across player + house (the 5% edge stays house-favorable
/// inside the payout), release the house lock, write the self-contained
/// provable-fairness record into the Round, and emit a RoundEvent. The caller is
/// responsible for the authorization/eligibility gate before invoking this:
///   - `close`               → owner check (`player.owner == player_authority`);
///   - `force_close`         → deadline check (`now >= deadline_ts`);
///   - `flip`/`lever`        → `settle::fires()` terminal-first check (settle a real
///                             liq/cap/time BEFORE re-anchoring, never after);
///   - `tick`/`tick_crank`   → `settle::fires()` guard inside `try_settle_tick` (it
///                             returns early on false, so this body only runs once a
///                             terminal or the time-cap has actually fired at the
///                             live price). `settle_round` itself re-asserts
///                             `status==1`, so a redundant call is a safe no-op.
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
        round.liq_fp as i128,
        round.refund_fp as i128,
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
    // init_if_needed: the vault ATA `[vault, mint]` is NOT seed-versioned, so re-running
    // init_house after a house-seed bump on a mint whose vault already exists (wSOL) must
    // reuse it — plain `init` fails "account already in use" and the v2 pot could never be
    // created. The associated_token constraints re-validate mint+authority when it exists.
    #[account(
        init_if_needed,
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
pub struct InitFeedRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = state::FeedRegistry::SIZE,
        seeds = [state::FEEDS_SEED],
        bump
    )]
    pub registry: Account<'info, state::FeedRegistry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetFeed<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [state::FEEDS_SEED],
        bump = registry.bump,
        has_one = authority @ RaiderError::NotOwner,
    )]
    pub registry: Account<'info, state::FeedRegistry>,
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
    /// CHECK: per-session HouseBalance till PDA to delegate
    #[account(mut, del, seeds = [HOUSE_SEED, mint.key().as_ref(), payer.key().as_ref()], bump)]
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

// slice_from_pot moves value master -> till on L1, BEFORE delegation. The master is the
// singleton `[house, mint]`; the till is the per-player `[house, mint, owner]` (same
// HouseBalance layout), init_if_needed so the first session of a wallet creates it and
// later sessions reuse it. Owner-signed (the player starting their own session).
#[derive(Accounts)]
pub struct SliceFromPot<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [HOUSE_SEED, mint.key().as_ref()],
        bump = master.bump,
    )]
    pub master: Account<'info, HouseBalance>,
    #[account(
        init_if_needed,
        payer = owner,
        space = HouseBalance::SIZE,
        seeds = [HOUSE_SEED, mint.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub till: Account<'info, HouseBalance>,
    pub system_program: Program<'info, System>,
}

// sweep_till consolidates a till back into the master on L1, AFTER the session
// undelegated. Permissionless: `payer` is any signer (pays only the tx fee). `owner` is
// the session owner whose till is swept — an AccountInfo used ONLY to derive the till
// PDA (not a signer), so a keeper can reclaim an abandoned session's slice while the
// normal path passes payer == owner == the player.
#[derive(Accounts)]
pub struct SweepTill<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    /// CHECK: session owner whose till is swept — used only to derive the till PDA seed.
    pub owner: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [HOUSE_SEED, mint.key().as_ref()],
        bump = master.bump,
    )]
    pub master: Account<'info, HouseBalance>,
    #[account(
        mut,
        seeds = [HOUSE_SEED, mint.key().as_ref(), owner.key().as_ref()],
        bump = till.bump,
    )]
    pub till: Account<'info, HouseBalance>,
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
        seeds = [HOUSE_SEED, mint.key().as_ref(), player.owner.as_ref()],
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
    /// CHECK: must equal registry.feeds[asset].feed (checked in the handler); the bytes are
    /// authenticated (owner + staleness) by price::read_fresh().
    pub price_update: AccountInfo<'info>,
    #[account(seeds = [FEEDS_SEED], bump = registry.bump)]
    pub registry: Account<'info, FeedRegistry>,
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
        seeds = [HOUSE_SEED, mint.key().as_ref(), player.owner.as_ref()],
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
    /// CHECK: must equal round.feed (the feed this round opened on); authenticated by read_fresh.
    #[account(constraint = price_update.key() == round.feed @ RaiderError::UntrustedFeed)]
    pub price_update: AccountInfo<'info>,
    pub player_authority: Signer<'info>,
}

// force_close has the SAME account shape as close EXCEPT the signer carries no
// ownership constraint — `caller` is ANY Signer. The Player PDA is re-derived
// from `player.owner` (the stored value), NOT from the signer, so a stranger
// can settle the round but cannot redirect funds: payout is credited to the
// round owner's PlayerBalance regardless of who calls.
//
// TWO instructions reuse this permissionless context, each with its OWN
// eligibility gate in the instruction body (the context itself authorizes nobody):
//   - `force_close` → the deadline gate (`now >= deadline_ts`) authorizes the call;
//   - `tick`        → the `settle::fires()` guard authorizes settlement (a terminal
//                     or the time-cap must have fired at the live price; otherwise
//                     it is a no-op heartbeat).
// In BOTH cases the program reads the authenticated price and renders the verdict,
// so a permissionless caller can never choose an outcome.
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
        seeds = [HOUSE_SEED, mint.key().as_ref(), player.owner.as_ref()],
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
    /// CHECK: must equal round.feed; permissionless, so the round-bound feed is the guard. Authenticated by read_fresh.
    #[account(constraint = price_update.key() == round.feed @ RaiderError::UntrustedFeed)]
    pub price_update: AccountInfo<'info>,
    // Permissionless: any signer (no owner constraint) — the deadline is the gate.
    pub caller: Signer<'info>,
}

// CrankClose mirrors ForceCloseRound MINUS the `caller: Signer` — the native crank
// is executed BY THE VALIDATOR with no client signer, so there is no signer slot.
// The Player/House/Round PDAs are re-derived from stored values (player.owner), so
// the crank can only ever settle THIS round's owner; the pinned feed + read_fresh
// authenticate the price. This is the no-signer twin of the `tick` context.
#[derive(Accounts)]
pub struct CrankClose<'info> {
    #[account(
        mut,
        seeds = [PLAYER_SEED, player.owner.as_ref(), mint.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, PlayerBalance>,
    #[account(
        mut,
        seeds = [HOUSE_SEED, mint.key().as_ref(), player.owner.as_ref()],
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
    /// CHECK: must equal round.feed; the no-signer crank is bound to the round's feed. Authenticated by read_fresh.
    #[account(constraint = price_update.key() == round.feed @ RaiderError::UntrustedFeed)]
    pub price_update: AccountInfo<'info>,
}

// ScheduleTick forwards the pubkeys the scheduled `tick_crank` ix needs into the
// ScheduleTask CPI. The forwarded PDAs are UncheckedAccount (NOT typed Account) so
// Anchor does NOT re-serialize delegated/stale data after the CPI — mirrors the
// spike's ScheduleIncrement, just with raider's extra accounts. The feed is pinned.
#[derive(Accounts)]
pub struct ScheduleTick<'info> {
    /// CHECK: the Magic program, used for the ScheduleTask CPI
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PlayerBalance PDA, forwarded to the scheduled-ix metas
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    /// CHECK: HouseBalance PDA, forwarded to the scheduled-ix metas
    #[account(mut)]
    pub house: UncheckedAccount<'info>,
    /// Round PDA — typed so we can read round.feed, and `mut` so the scheduled
    /// tick_crank's writable `round` meta inherits write privilege (else the
    /// MagicBlock scheduler rejects the task with PrivilegeEscalation). schedule_tick
    /// never mutates it; the re-serialize writes identical bytes.
    #[account(mut, seeds = [ROUND_SEED, round.owner.as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    /// CHECK: mint, forwarded to the scheduled-ix metas
    pub mint: UncheckedAccount<'info>,
    /// CHECK: must equal round.feed; forwarded to the scheduled-ix metas. Authenticated by read_fresh at run time.
    #[account(constraint = price_update.key() == round.feed @ RaiderError::UntrustedFeed)]
    pub price_update: AccountInfo<'info>,
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
    #[account(mut, seeds = [HOUSE_SEED, mint.key().as_ref(), player.owner.as_ref()], bump = house.bump)]
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
    /// open/set_feed got an asset index outside the registry, or an unregistered/disabled feed.
    UnknownAsset,
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
