# Phase 2 — Continuous Settlement + Mid-Round Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the on-chain round a live, continuously-settled state machine — liquidate/cap the moment an on-chain-observed price crosses the threshold, auto-close at a 60s time-cap, and support flip/lever mid-round — all settled against the hardened Lazer feed and recomputable by anyone.

**Architecture:** Extend the Phase-1 `raider` Anchor program (on the MagicBlock ER). `Round` gains a `banked: i128` accumulator and mutable `dir/lev/entry_raw`. A permissionless `tick` instruction (called by a house keeper now, native crank later) reads the authenticated price and settles only when liq/cap/time fires. `flip`/`lever` realize the current segment via `rebank` then re-anchor. The trigger picks *when* to call; the program picks the price and the verdict.

**Tech Stack:** Anchor 0.32.1 (`~/.avm/bin/anchor-0.32.1`), `ephemeral-rollups-sdk` 0.15.5 (`anchor-compat`), Rust fixed-point settle (i128, no f64), ts-mocha devnet driver (Helius base RPC + `https://devnet.magicblock.app` ER), Pyth Lazer BTC feed.

**Spec:** `docs/superpowers/specs/2026-06-28-phase2-continuous-settlement-design.md`

---

## File Structure

- `onchain/raider/programs/raider/src/settle.rs` — **modify**: `Outcome::Time`; `banked` threaded through `equity_fp`/`settle`; new `rebank_fp`, `fires`; unit tests rewritten for the new signatures.
- `onchain/raider/programs/raider/src/state.rs` — **modify**: `Round.banked: i128`; `SIZE` 116→132; `MAX_ROUND_SECS` 300→60.
- `onchain/raider/programs/raider/src/lib.rs` — **modify**: `init_round`/`open` reset `banked`; `settle_round` threads `banked`+`now`+time-relabel+event; `close`/`force_close` pass `now`; new `tick`/`flip`/`lever`; `RoundEvent`; `BadDirection`; (conditional) `schedule_tick`/`cancel_tick`.
- `onchain/raider/tests/keeper.ts` — **create**: the house keeper tick-loop helper.
- `onchain/raider/tests/tick-liq.ts` — **create**: continuous 2000× liquidation via the keeper (wiring proof).
- `onchain/raider/tests/flip.ts` — **create**: flip parity vs a BigInt sequence mirror.
- `onchain/raider/tests/lever.ts` — **create**: lever parity vs the mirror.
- `onchain/raider/tests/timecap.ts` — **create**: 60s time terminal (via `test-short-deadline`).
- `onchain/raider/tests/raceguard.ts` — **create**: flip-after-settle rejected.
- `spikes/crank-probe/` — **create**: a standalone `ScheduleTask` availability probe on our devnet ER validator.
- `onchain/raider/RESULT.md` — **modify**: continuous-tick latency + crank-probe verdict.

**Cap-outcome coverage note:** a deterministic *on-chain* cap requires a +1.25% BTC move at 2000× inside the round — not controllable on a live feed. Cap is therefore proven deterministically at the **unit level** (`settle.rs` `terminal`/`fires`/`cap_clamp`), and exercised opportunistically on-chain. Liq and time are deterministic on-chain (any ≥0.05% adverse move liquidates a 2000× position; the time-cap fires on the clock).

---

## Task 1: settle.rs — banked, Outcome::Time, rebank_fp, fires (pure Rust)

**Files:**
- Modify: `onchain/raider/programs/raider/src/settle.rs`
- Test: same file (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Rewrite the test module to the new banked-aware signatures and add the new cases**

Replace the entire `#[cfg(test)] mod tests { ... }` block with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // banked = 0 path (Phase-1 parity): long, 100x, +1% => equity 2.0x, cashout.
    #[test]
    fn long_winner_no_bank() {
        let (o, p) = settle(0, 1, 100, 1_000_000, 60_000, 60_600);
        assert_eq!(o, Outcome::Cashout);
        assert_eq!(p, 1_900_000); // floor(1e6 * 2e6 * 950_000 / 1e12)
    }

    // banked = 0: long, 1000x, -0.1% => equity 0 <= LIQ => Liq, payout 0.
    #[test]
    fn long_liquidated_no_bank() {
        let (o, p) = settle(0, 1, 1000, 1_000_000, 60_000, 59_940);
        assert_eq!(o, Outcome::Liq);
        assert_eq!(p, 0);
    }

    // cap clamp: long, 2000x, +1.5% => raw equity 31x >= CAP => Cap, payout = max_payout.
    #[test]
    fn cap_clamp_no_bank() {
        let (o, p) = settle(0, 1, 2000, 1_000_000, 60_000, 60_900);
        assert_eq!(o, Outcome::Cap);
        assert_eq!(p, max_payout(1_000_000)); // 23_750_000
    }

    #[test]
    fn max_payout_is_23_75x() {
        assert_eq!(max_payout(1_000_000), 23_750_000);
    }

    // rebank: long 10x, entry 100, price 110 (+10%) => segment = 10*(1_100_000-1e6)
    // = 10*100_000 = 1_000_000; banked 0 -> 1_000_000 (i.e. +1.0 realized).
    #[test]
    fn rebank_realizes_segment() {
        let b = rebank_fp(0, 1, 10, 100, 110);
        assert_eq!(b, 1_000_000);
    }

    // equity carries banked: with banked = 1_000_000 (+1.0), a flat new segment
    // (price == entry) => equity = SCALE + banked + 0 = 2_000_000 (= 2.0x).
    #[test]
    fn equity_includes_banked() {
        let eq = equity_fp(1_000_000, 1, 10, 110, 110);
        assert_eq!(eq, 2_000_000);
    }

    // Mirror packages/engine settle.test.ts "flip" vector with integer math:
    // open long 10x entry 100; flip to short at 110; exit 105.
    //   banked after flip = 0 + 10*(1_100_000-1e6) = 1_000_000
    //   exit segment (dir -1, lev 10, entry 110, exit 105):
    //     ratio = 105*1e6/110 = 954_545; -10*(954_545-1e6) = -10*(-45_455)=454_550
    //   equity = 1e6 + 1_000_000 + 454_550 = 2_454_550 => cashout.
    #[test]
    fn flip_sequence_matches_engine() {
        let banked = rebank_fp(0, 1, 10, 100, 110);
        let eq = equity_fp(banked, -1, 10, 110, 105);
        let (o, _) = terminal(eq);
        assert_eq!(o, Outcome::Cashout);
        assert_eq!(eq, 2_454_550);
    }

    // fires(): liq, cap, time(now>=deadline), and the heartbeat no-op (false).
    #[test]
    fn fires_predicate() {
        // adverse 2000x => liq => fires
        assert!(fires(0, 1, 2000, 60_000, 59_970, 100, 1_000_000));
        // favorable small move, before deadline => no terminal => heartbeat (false)
        assert!(!fires(0, 1, 100, 60_000, 60_060, 100, 1_000_000));
        // same benign price but now >= deadline => time => fires
        assert!(fires(0, 1, 100, 60_000, 60_060, 1_000_000, 1_000_000));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail (signatures don't exist yet)**

Run: `cd onchain/raider/programs/raider && cargo test`
Expected: FAIL — `settle`/`equity_fp` arity mismatch, `rebank_fp`/`fires`/`Outcome::Time` undefined.

- [ ] **Step 3: Implement the banked-aware module**

In `settle.rs`: add `Time` to the enum + `code()`, thread `banked_fp` through `equity_fp`/`settle`, add `rebank_fp` and `fires`. Apply these edits:

Enum + code:
```rust
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Outcome {
    Cashout,
    Cap,
    Liq,
    Time,
}

impl Outcome {
    /// Stable wire code stored in `Round.outcome`: 0 cashout / 1 cap / 2 liq / 3 time.
    pub fn code(self) -> u8 {
        match self {
            Outcome::Cashout => 0,
            Outcome::Cap => 1,
            Outcome::Liq => 2,
            Outcome::Time => 3,
        }
    }
}
```

Realize-a-segment + equity (equity reuses rebank so the two can never drift):
```rust
/// Realize the current segment into banked: banked + dir*lev*(price/entry - 1).
/// Integer port of packages/engine economics.ts `rebank`. Signed (can go negative).
pub fn rebank_fp(banked_fp: i128, dir: i8, lev: u32, entry_raw: i64, price_raw: i64) -> i128 {
    let ratio = (price_raw as i128) * SCALE / (entry_raw as i128);
    banked_fp + (dir as i128) * (lev as i128) * (ratio - SCALE)
}

/// equity_fp = SCALE + banked + dir*lev*(exit/entry - 1), clamped >= 0.
/// Integer port of economics.ts `equityOf`. Same feed => the expo cancels in `ratio`.
pub fn equity_fp(banked_fp: i128, dir: i8, lev: u32, entry_raw: i64, exit_raw: i64) -> i128 {
    let eq = SCALE + rebank_fp(banked_fp, dir, lev, entry_raw, exit_raw);
    if eq < 0 {
        0
    } else {
        eq
    }
}
```

`terminal`, `payout`, `max_payout` are unchanged. Update `settle` to take `banked_fp`:
```rust
/// Full settle for one mark (liq/cap/cashout precedence; time is layered by the
/// caller, which has `now`/`deadline_ts`).
pub fn settle(
    banked_fp: i128,
    dir: i8,
    lev: u32,
    stake: u64,
    entry_raw: i64,
    exit_raw: i64,
) -> (Outcome, u64) {
    let (o, eq) = terminal(equity_fp(banked_fp, dir, lev, entry_raw, exit_raw));
    (o, payout(stake, eq))
}

/// True iff a terminal fires at this mark: liq/cap by equity, OR the 60s time-cap
/// by the clock. The keeper/crank calls `tick`, which settles only when this is true.
pub fn fires(
    banked_fp: i128,
    dir: i8,
    lev: u32,
    entry_raw: i64,
    exit_raw: i64,
    now: i64,
    deadline_ts: i64,
) -> bool {
    let (term, _) = terminal(equity_fp(banked_fp, dir, lev, entry_raw, exit_raw));
    term != Outcome::Cashout || now >= deadline_ts
}
```

Also update the module's top doc comment line about `equityOf` to reflect that `banked` is now threaded (drop the "Phase 1 has no mid-round actions, so banked = 0" line).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd onchain/raider/programs/raider && cargo test`
Expected: PASS — 8/8 (3 no-bank parity + max_payout + rebank + equity-banked + flip-sequence + fires).

- [ ] **Step 5: Commit**

```bash
git add onchain/raider/programs/raider/src/settle.rs
git commit -m "feat(raider): thread banked through settle; add rebank_fp, fires, Outcome::Time

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: state.rs — banked field, SIZE 132, 60s cap; reset banked on open

**Files:**
- Modify: `onchain/raider/programs/raider/src/state.rs`
- Modify: `onchain/raider/programs/raider/src/lib.rs` (`init_round`, `open`)

- [ ] **Step 1: Add `banked` to `Round`, bump SIZE, set the 60s cap**

In `state.rs`, change the deadline constant comment + value:
```rust
// The game time-cap: a round auto-closes at this age (outcome = time), settling
// at the then-current price. ALSO the permissionless `force_close` deadline (the
// liveness backstop if the keeper/crank AND the player all go silent). 60s in
// prod; `test-short-deadline` shrinks it to 8s so the time/force_close paths can
// be exercised without a long wait. MUST be off in any real deployment.
#[cfg(not(feature = "test-short-deadline"))]
pub const MAX_ROUND_SECS: i64 = 60;
#[cfg(feature = "test-short-deadline")]
pub const MAX_ROUND_SECS: i64 = 8;
```

Add `banked` to the `Round` struct (after `entry_ts`, grouping it with the live position state) and update SIZE:
```rust
#[account]
pub struct Round {
    pub owner: Pubkey,
    pub dir: i8,
    pub lev: u32,
    pub stake: u64,
    pub entry_raw: i64,
    pub entry_expo: i32,
    pub entry_ts: i64,
    pub banked: i128, // realized P&L accumulator (SCALE units); mutated by flip/lever
    pub max_payout: u64,
    pub deadline_ts: i64,
    pub status: u8,
    pub bump: u8,
    // --- settlement record (written at settle; zero while open/idle) ---
    pub exit_raw: i64,
    pub exit_ts: i64,
    pub payout: u64,
    pub outcome: u8,
}
impl Round {
    // disc(8) + owner(32) + dir(1) + lev(4) + stake(8) + entry_raw(8)
    //  + entry_expo(4) + entry_ts(8) + banked(16) + max_payout(8) + deadline_ts(8)
    //  + status(1) + bump(1)                                  = 107 (base)
    //  + exit_raw(8) + exit_ts(8) + payout(8) + outcome(1)    = 25 (record)
    //  = 132 total.
    pub const SIZE: usize =
        8 + 32 + 1 + 4 + 8 + 8 + 4 + 8 + 16 + 8 + 8 + 1 + 1 + 8 + 8 + 8 + 1;
}
```

Update the `dir/lev` line in `Round`'s status doc comment (`outcome: 0 cashout, 1 cap, 2 liq`) to `outcome: 0 cashout, 1 cap, 2 liq, 3 time.`

- [ ] **Step 2: Reset `banked` in `init_round` and `open`**

In `lib.rs` `init_round`, add after `r.entry_ts = 0;`:
```rust
        r.banked = 0;
```

In `lib.rs` `open`, the Round PDA is reused across rounds, so reset `banked` alongside the existing settlement-record clears. Add after `round.entry_ts = snap.publish_time;`:
```rust
        round.banked = 0;
```

- [ ] **Step 3: Build (default + short-deadline feature) to verify it compiles**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build && ~/.avm/bin/anchor-0.32.1 build -- --features test-short-deadline`
Expected: both build clean. (`settle_round`'s `settle::settle` call still has the old arity — that's fixed in Task 3; if you build before Task 3 it will error there. Build only `cargo check -p raider` here, or proceed to Task 3 and build once. To keep this task self-contained, run `cargo check` and expect the only error to be the `settle::settle`/arity in `lib.rs`, which Task 3 fixes.)

- [ ] **Step 4: Commit**

```bash
git add onchain/raider/programs/raider/src/state.rs onchain/raider/programs/raider/src/lib.rs
git commit -m "feat(raider): Round.banked i128, SIZE 132, MAX_ROUND_SECS 60

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: settle_round — thread banked + now + time-relabel + RoundEvent

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs`

- [ ] **Step 1: Add the `BadDirection` error and the `RoundEvent` event**

In `lib.rs`, add to `RaiderError` (after `UntrustedFeed`):
```rust
    /// flip got a direction that is not +1 or -1.
    BadDirection,
```

Add the event near the bottom of the file (after the `RaiderError` enum):
```rust
/// Emitted on every Round state transition so the entire path is reconstructable
/// from chain history (final committed Round + this event stream = provable trail).
/// kind: 0 open, 1 flip, 2 lever, 3 settle. price_raw/ts come from the authenticated
/// Lazer read; banked/dir/lev are the values AFTER the transition.
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
```

- [ ] **Step 2: Rewrite `settle_round` to thread `banked` + `now` + the time relabel + emit**

Replace the `fn settle_round(...)` body with:
```rust
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
        equity_fp: settle::equity_fp(round.banked, round.dir, round.lev, round.entry_raw, snap.price),
        outcome: outcome.code(),
        payout,
    });
    Ok(())
}
```

- [ ] **Step 3: Pass `now` from `close` and `force_close`**

In `close`, change the `settle_round(...)` call to pass `now`:
```rust
        settle_round(
            &mut ctx.accounts.player,
            &mut ctx.accounts.house,
            &mut ctx.accounts.round,
            &snap,
            now,
        )
```
Apply the identical `now` argument to the `settle_round(...)` call in `force_close`.

- [ ] **Step 4: Emit an `open` event**

At the end of `open`, just before `Ok(())`, add:
```rust
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
```

- [ ] **Step 5: Build both feature configs**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build && ~/.avm/bin/anchor-0.32.1 build -- --features test-short-deadline`
Expected: both build clean (the IDL now includes `banked`, `RoundEvent`, `BadDirection`).

- [ ] **Step 6: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs
git commit -m "feat(raider): settle_round threads banked+time relabel+RoundEvent; close/force_close pass now

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: tick instruction + keeper helper + continuous-liq devnet test

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs` (`tick`)
- Create: `onchain/raider/tests/keeper.ts`
- Create: `onchain/raider/tests/tick-liq.ts`

- [ ] **Step 1: Add the permissionless `tick` instruction**

In `lib.rs`, inside `pub mod raider`, after `force_close`, add (it reuses the `ForceCloseRound` context — identical accounts, permissionless `caller`, pinned feed):
```rust
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
```

- [ ] **Step 2: Rebuild + deploy the upgrade to devnet**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build -- --features test-short-deadline` then upgrade the deployed program (same id `FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv`) per the Phase-1 deploy procedure (Helius RPC `https://devnet.helius-rpc.com/?api-key=...`; `solana program deploy target/deploy/raider.so --program-id target/deploy/raider-keypair.json -u <helius>`). Copy the new IDL into `target/idl/raider.json` (anchor build does this).
Expected: upgrade succeeds; `idl.json` lists `tick`, `flip`(after Task 5), `banked`.

- [ ] **Step 3: Write the keeper helper**

Create `onchain/raider/tests/keeper.ts`:
```js
// Minimal house keeper: tick the open round on the ER until it settles (or maxTicks).
// PERMISSIONLESS — `caller` is just whoever pays the tx; the program decides the verdict.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runKeeper(programER, accounts, signer, opts = {}) {
  const intervalMs = opts.intervalMs ?? 200;
  const maxTicks = opts.maxTicks ?? 400;
  for (let i = 0; i < maxTicks; i++) {
    const r = await programER.account.round.fetch(accounts.round);
    if (r.status === 2) return r;
    try {
      await programER.methods
        .tick()
        .accounts({
          player: accounts.player,
          house: accounts.house,
          round: accounts.round,
          mint: accounts.mint,
          priceUpdate: accounts.btcFeed,
          caller: signer.publicKey,
        })
        .signers([signer])
        .rpc({ skipPreflight: true });
    } catch (e) {
      // heartbeat no-op error / transient race — keep polling status.
    }
    await sleep(intervalMs);
  }
  return await programER.account.round.fetch(accounts.round);
}

module.exports = { runKeeper };
```

- [ ] **Step 4: Write the continuous-liq test**

Create `onchain/raider/tests/tick-liq.ts`. Build it on the SAME mint/house/session setup proven in `tests/raider.ts` (createMint → init_house → fund_house → buy_in → init_round → delegate_session → ER provider). Open TWO sessions, one LONG 2000× and one SHORT 2000×, so on the very next tick exactly one side is underwater by ≥0.05% and MUST liquidate. Drive both with the keeper and assert the liquidated side settled via `tick` with `payout == 0`, lock released, value conserved:

```js
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const {
  createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync,
  mintTo, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const assert = require("assert");
const idl = require("../target/idl/raider.json");
const { BN } = anchor;
const { runKeeper } = require("./keeper");

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC || "https://devnet.magicblock.app";
const ER_WS = process.env.ER_WS || "wss://devnet.magicblock.app";
const BTC_FEED = new PublicKey(process.env.BTC_FEED || "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");
const VALIDATOR = new PublicKey(process.env.ER_VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAKE = 1_000_000;

describe("raider — continuous 2000x liquidation via tick (keeper-driven)", function () {
  this.timeout(1_000_000);
  const funder = anchor.Wallet.local();
  const baseConn = new anchor.web3.Connection(BASE_RPC, { commitment: "confirmed" });
  const baseProvider = new anchor.AnchorProvider(baseConn, funder, { commitment: "confirmed" });
  anchor.setProvider(baseProvider);
  const program = new anchor.Program(idl, baseProvider);

  it("opens long+short 2000x; the underwater side liquidates through tick (payout 0, lock released, conserved)", async () => {
    const conn = baseConn;
    const mint = await createMint(conn, funder.payer, funder.publicKey, null, 6);
    const [housePda] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);

    await program.methods.initHouse().accounts({
      authority: funder.publicKey, mint, house: housePda, vaultAuthority, vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc({ skipPreflight: true });

    // Fund the house for TWO concurrent 2000x rounds (2 * 23.75).
    const HOUSE_FUND = 60_000_000;
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, funder.publicKey);
    await mintTo(conn, funder.payer, mint, funderAta.address, funder.publicKey, HOUSE_FUND);
    await program.methods.fundHouse(new BN(HOUSE_FUND)).accounts({
      funder: funder.publicKey, mint, house: housePda, funderToken: funderAta.address,
      vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc({ skipPreflight: true });

    // Open one session per direction. Returns the per-session handles for the keeper.
    async function openSide(dir) {
      const session = Keypair.generate();
      await baseProvider.sendAndConfirm(new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: session.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL })));
      const sp = new anchor.AnchorProvider(conn, new anchor.Wallet(session), { commitment: "confirmed" });
      const pAs = new anchor.Program(idl, sp);
      const [player] = PublicKey.findProgramAddressSync([Buffer.from("player"), session.publicKey.toBuffer(), mint.toBuffer()], program.programId);
      const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), session.publicKey.toBuffer()], program.programId);
      const ownerAta = await getOrCreateAssociatedTokenAccount(conn, funder.payer, mint, session.publicKey);
      await mintTo(conn, funder.payer, mint, ownerAta.address, funder.publicKey, 5_000_000);
      await pAs.methods.buyIn(new BN(5_000_000)).accounts({
        owner: session.publicKey, mint, player, ownerToken: ownerAta.address,
        vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc({ skipPreflight: true });
      await pAs.methods.initRound().accounts({ owner: session.publicKey, round, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
      await pAs.methods.delegateSession().accounts({ payer: session.publicKey, mint, player, house: housePda, round })
        .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]).rpc({ skipPreflight: true });
      const erProvider = new anchor.AnchorProvider(
        new anchor.web3.Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }),
        new anchor.Wallet(session), { commitment: "confirmed" });
      const programER = new anchor.Program(idl, erProvider);
      // wait for delegation to land, then open 2000x
      await sleep(8000);
      await programER.methods.open(dir, 2000, new BN(STAKE)).accounts({
        player, house: housePda, round, mint, priceUpdate: BTC_FEED, playerAuthority: session.publicKey,
      }).signers([session]).rpc({ skipPreflight: true });
      return { session, programER, accounts: { player, house: housePda, round, mint, btcFeed: BTC_FEED } };
    }

    const long = await openSide(1);
    const short = await openSide(-1);

    // House lock now reserves both rounds' max-payout.
    const lockedAfterOpen = BigInt((await long.programER.account.houseBalance.fetch(housePda)).locked.toString());
    assert.equal(lockedAfterOpen.toString(), (2n * 23_750_000n).toString(), "both 2000x rounds pre-locked");

    // Drive both with the keeper. At 2000x any >=0.05% move liquidates the wrong side.
    const [lr, sr] = await Promise.all([
      runKeeper(long.programER, long.accounts, long.session, { intervalMs: 200, maxTicks: 200 }),
      runKeeper(short.programER, short.accounts, short.session, { intervalMs: 200, maxTicks: 200 }),
    ]);

    // Exactly one side must have liquidated through tick (outcome 2, payout 0).
    const liquidated = [lr, sr].filter((r) => r.status === 2 && r.outcome === 2);
    assert.ok(liquidated.length >= 1, `at least one 2000x side must liquidate, got long=${lr.outcome}/${lr.status} short=${sr.outcome}/${sr.status}`);
    for (const r of liquidated) {
      assert.equal(r.payout.toString(), "0", "a liquidation pays 0");
    }

    // The liquidated round(s) released their lock; conservation holds at house level.
    const lockedAfter = BigInt((await long.programER.account.houseBalance.fetch(housePda)).locked.toString());
    assert.ok(lockedAfter < lockedAfterOpen, "the liquidated round released its house lock");
    console.log(`continuous-liq: long outcome=${lr.outcome} short outcome=${sr.outcome}; lock ${lockedAfterOpen} -> ${lockedAfter}`);
  });
});
```

- [ ] **Step 5: Run the test (needs devnet SOL + the deployed upgrade)**

Run: `cd onchain/raider && BTC_FEED=71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr npx ts-mocha -p ./tsconfig.json -t 1000000 tests/tick-liq.ts`
Expected: PASS — both rounds pre-lock 23.75 each; the underwater 2000× side liquidates through `tick` with payout 0; lock drops.

- [ ] **Step 6: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs onchain/raider/tests/keeper.ts onchain/raider/tests/tick-liq.ts
git commit -m "feat(raider): permissionless tick continuous settler + keeper helper + continuous-liq test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: flip instruction + parity test

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs` (`flip`)
- Create: `onchain/raider/tests/flip.ts`

- [ ] **Step 1: Add the `flip` instruction (owner-authority, terminal-first, reuses `CloseRound`)**

In `lib.rs`, after `tick`, add:
```rust
    /// Reverse direction mid-round (owner-authority). Reads the live authenticated
    /// price; if it already liq/caps or the cap-time has passed, SETTLES instead of
    /// flipping (matches off-chain terminalAt-before-applyAction). Otherwise realizes
    /// the current segment into `banked`, re-anchors `entry_raw`, and reverses `dir`.
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
            ctx.accounts.round.banked, ctx.accounts.round.dir, ctx.accounts.round.lev,
            ctx.accounts.round.entry_raw, snap.price, now, ctx.accounts.round.deadline_ts,
        ) {
            return settle_round(
                &mut ctx.accounts.player, &mut ctx.accounts.house,
                &mut ctx.accounts.round, &snap, now,
            );
        }

        let round = &mut ctx.accounts.round;
        round.banked = settle::rebank_fp(round.banked, round.dir, round.lev, round.entry_raw, snap.price);
        round.entry_raw = snap.price;
        round.entry_expo = snap.exponent;
        round.dir = new_dir;
        emit!(RoundEvent {
            owner: round.owner, kind: 1, price_raw: snap.price, ts: snap.publish_time,
            banked: round.banked, dir: round.dir, lev: round.lev,
            equity_fp: settle::equity_fp(round.banked, round.dir, round.lev, round.entry_raw, snap.price),
            outcome: 0, payout: 0,
        });
        Ok(())
    }
```

- [ ] **Step 2: Rebuild + deploy upgrade**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build -- --features test-short-deadline` then upgrade the deployed program (Task 4 Step 2 procedure). Refresh `target/idl/raider.json`.

- [ ] **Step 3: Write the flip parity test**

Create `onchain/raider/tests/flip.ts`. Reuse the single-session setup from `tests/raider.ts` (one session, low leverage so the round does NOT liquidate mid-flip). Open long 50× → `flip(-1)` → `close`; capture the on-chain prices (open entry, flip price = `entry_raw` after flip, exit) and assert the on-chain payout equals a **BigInt sequence mirror** (NOT the float engine):

```js
// ... standard imports + provider/mint/house/buy_in/init_round/delegate setup
// identical to tests/raider.ts up to the ER provider (programER, playerPda, roundPda,
// housePda, session, mint) ...

// --- BigInt sequence mirror of settle.rs (banked-aware) ---
const SCALE = 1_000_000n, EDGE_FP = 50_000n, LIQ_FP = 200_000n, CAP_FP = 25_000_000n;
const rebankFp = (b, dir, lev, entry, price) => b + dir * lev * ((price * SCALE) / entry - SCALE);
const equityFpB = (b, dir, lev, entry, exit) => { let e = SCALE + rebankFp(b, dir, lev, entry, exit); return e < 0n ? 0n : e; };
const terminal = (eq) => eq <= LIQ_FP ? { code: 2, settled: 0n } : eq >= CAP_FP ? { code: 1, settled: CAP_FP } : { code: 0, settled: eq };
const payoutFp = (stake, eq) => (stake * eq * (SCALE - EDGE_FP)) / SCALE / SCALE;
function settleSeq(stake, dir0, lev0, entry0, actions, exitRaw) {
  let b = 0n, dir = BigInt(dir0), lev = BigInt(lev0), entry = BigInt(entry0);
  for (const a of actions) {
    const t = terminal(equityFpB(b, dir, lev, entry, BigInt(a.priceRaw)));
    if (t.code !== 0) return { outcome: t.code, payout: payoutFp(BigInt(stake), t.settled) };
    b = rebankFp(b, dir, lev, entry, BigInt(a.priceRaw));
    entry = BigInt(a.priceRaw);
    if (a.kind === "flip") dir = BigInt(a.dir);
    else if (a.kind === "lever") lev = BigInt(a.lev);
  }
  const t = terminal(equityFpB(b, dir, lev, entry, BigInt(exitRaw)));
  return { outcome: t.code, payout: payoutFp(BigInt(stake), t.settled) };
}

// open long 50x
await programER.methods.open(1, 50, new BN(STAKE)).accounts({
  player: playerPda, house: housePda, round: roundPda, mint, priceUpdate: BTC_FEED, playerAuthority: session.publicKey,
}).signers([session]).rpc({ skipPreflight: true });
const o = await programER.account.round.fetch(roundPda);
const entry0 = BigInt(o.entryRaw.toString());

await sleep(1500);
// flip to short
await programER.methods.flip(-1).accounts({
  player: playerPda, house: housePda, round: roundPda, mint, priceUpdate: BTC_FEED, playerAuthority: session.publicKey,
}).signers([session]).rpc({ skipPreflight: true });
const f = await programER.account.round.fetch(roundPda);
assert.equal(f.dir, -1, "dir flipped to short");
assert.equal(f.status, 1, "still open after flip (low lev, no liq)");
const flipPrice = BigInt(f.entryRaw.toString());

await sleep(1500);
// close
await programER.methods.close().accounts({
  player: playerPda, house: housePda, round: roundPda, mint, priceUpdate: BTC_FEED, playerAuthority: session.publicKey,
}).signers([session]).rpc({ skipPreflight: true });
const s = await programER.account.round.fetch(roundPda);
const exitRaw = BigInt(s.exitRaw.toString());

const expected = settleSeq(STAKE, 1, 50, entry0, [{ kind: "flip", dir: -1, priceRaw: flipPrice }], exitRaw);
assert.equal(s.payout.toString(), expected.payout.toString(), "on-chain flip payout == BigInt sequence mirror");
assert.equal(s.outcome, expected.outcome, "on-chain flip outcome == mirror");
console.log(`flip parity OK: entry0=${entry0} flip=${flipPrice} exit=${exitRaw} payout=${s.payout} (mirror ${expected.payout})`);
```

Place this inside an `it(...)` after the standard setup (copy setup verbatim from `tests/raider.ts` lines for mint→ER provider; the implementer adapts the variable names).

- [ ] **Step 4: Run the flip test**

Run: `cd onchain/raider && BTC_FEED=71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr npx ts-mocha -p ./tsconfig.json -t 1000000 tests/flip.ts`
Expected: PASS — `dir` flips, round stays open, and the on-chain payout matches the BigInt sequence mirror exactly.

- [ ] **Step 5: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs onchain/raider/tests/flip.ts
git commit -m "feat(raider): flip mid-round action (terminal-first rebank) + parity test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: lever instruction + parity test

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs` (`lever`)
- Create: `onchain/raider/tests/lever.ts`

- [ ] **Step 1: Add the `lever` instruction**

In `lib.rs`, after `flip`, add (same shape; validates the new leverage, changes `lev` not `dir`):
```rust
    /// Change leverage mid-round (owner-authority). Same terminal-first + rebank as
    /// `flip`, but re-anchors at the new leverage instead of reversing direction.
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
            ctx.accounts.round.banked, ctx.accounts.round.dir, ctx.accounts.round.lev,
            ctx.accounts.round.entry_raw, snap.price, now, ctx.accounts.round.deadline_ts,
        ) {
            return settle_round(
                &mut ctx.accounts.player, &mut ctx.accounts.house,
                &mut ctx.accounts.round, &snap, now,
            );
        }

        let round = &mut ctx.accounts.round;
        round.banked = settle::rebank_fp(round.banked, round.dir, round.lev, round.entry_raw, snap.price);
        round.entry_raw = snap.price;
        round.entry_expo = snap.exponent;
        round.lev = new_lev;
        emit!(RoundEvent {
            owner: round.owner, kind: 2, price_raw: snap.price, ts: snap.publish_time,
            banked: round.banked, dir: round.dir, lev: round.lev,
            equity_fp: settle::equity_fp(round.banked, round.dir, round.lev, round.entry_raw, snap.price),
            outcome: 0, payout: 0,
        });
        Ok(())
    }
```

- [ ] **Step 2: Rebuild + deploy upgrade** (Task 4 Step 2 procedure; refresh IDL).

- [ ] **Step 3: Write the lever parity test**

Create `onchain/raider/tests/lever.ts` — identical to `flip.ts` but: open long 100× → `lever(500)` → close, and the action is `{ kind: "lever", lev: 500, priceRaw: leverPrice }`. Assert `f.lev === 500`, `f.status === 1`, and the on-chain payout equals `settleSeq(STAKE, 1, 100, entry0, [{ kind: "lever", lev: 500, priceRaw: leverPrice }], exitRaw)`. (Choose 100×→500× and short waits so the round does not liquidate mid-action.)

- [ ] **Step 4: Run the lever test**

Run: `cd onchain/raider && BTC_FEED=71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr npx ts-mocha -p ./tsconfig.json -t 1000000 tests/lever.ts`
Expected: PASS — `lev` becomes 500, round stays open, payout matches the mirror.

- [ ] **Step 5: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs onchain/raider/tests/lever.ts
git commit -m "feat(raider): lever mid-round action + parity test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: time-cap + race-guard tests

**Files:**
- Create: `onchain/raider/tests/timecap.ts`
- Create: `onchain/raider/tests/raceguard.ts`

(Both need the `test-short-deadline` build deployed: `MAX_ROUND_SECS = 8`.)

- [ ] **Step 1: Write the time-cap test**

Create `onchain/raider/tests/timecap.ts`. Reuse the single-session setup. Open **low leverage (10×)** so the round will neither liquidate (needs −2%) nor cap (needs +250%) within 8s — leaving the **time** terminal as the deterministic outcome. Run the keeper; assert the round settles `outcome === 3` (time) at the current equity with `status === 2`, conserved:

```js
// ...standard setup to the ER provider, then:
await programER.methods.open(1, 10, new BN(STAKE)).accounts({
  player: playerPda, house: housePda, round: roundPda, mint, priceUpdate: BTC_FEED, playerAuthority: session.publicKey,
}).signers([session]).rpc({ skipPreflight: true });

const accounts = { player: playerPda, house: housePda, round: roundPda, mint, btcFeed: BTC_FEED };
const r = await runKeeper(programER, accounts, session, { intervalMs: 300, maxTicks: 60 }); // > 8s of ticks

assert.equal(r.status, 2, "round settled");
assert.equal(r.outcome, 3, "10x over the 8s cap settles as time");
assert.ok(BigInt(r.payout.toString()) > 0n, "time settle pays the current (non-liq) equity");
const houseLocked = BigInt((await programER.account.houseBalance.fetch(housePda)).locked.toString());
assert.equal(houseLocked.toString(), "0", "house lock released after time settle");
console.log(`timecap: outcome=${r.outcome}(time) payout=${r.payout} after the 8s cap`);
```

Build/deploy note (Step 3 below): this requires the `test-short-deadline` program deployed.

- [ ] **Step 2: Write the race-guard test**

Create `onchain/raider/tests/raceguard.ts`. Open low leverage; wait past the 8s deadline; `force_close` (settles, status→2); then attempt `flip(-1)` and assert it is REJECTED with `NoOpenRound`:

```js
// ...setup + open(1, 10, STAKE) on the ER...
await sleep(10_000); // > 8s short deadline
await programER.methods.forceClose().accounts({
  player: playerPda, house: housePda, round: roundPda, mint, priceUpdate: BTC_FEED, caller: session.publicKey,
}).signers([session]).rpc({ skipPreflight: true });
const settled = await programER.account.round.fetch(roundPda);
assert.equal(settled.status, 2, "force_close settled the round");

let rejected = false, err = "";
try {
  await programER.methods.flip(-1).accounts({
    player: playerPda, house: housePda, round: roundPda, mint, priceUpdate: BTC_FEED, playerAuthority: session.publicKey,
  }).signers([session]).rpc({ skipPreflight: true });
} catch (e) { rejected = true; err = (e && e.toString()) || ""; }
assert.ok(rejected, "flip after settle MUST be rejected");
assert.ok(/NoOpenRound|6003|0x/i.test(err), "rejection must be NoOpenRound, got: " + err.split("\n").slice(0, 4).join(" "));
console.log("raceguard: flip after settle REJECTED (NoOpenRound)");
```

(Confirm the exact `NoOpenRound` error code from the built IDL and tighten the regex.)

- [ ] **Step 3: Build + deploy the `test-short-deadline` program, then run both tests**

Run:
```
cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build -- --features test-short-deadline
# upgrade the deployed program (Task 4 Step 2 procedure)
BTC_FEED=71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr npx ts-mocha -p ./tsconfig.json -t 1000000 tests/timecap.ts tests/raceguard.ts
```
Expected: timecap settles `outcome=3` payout>0 lock released; raceguard rejects the post-settle flip with `NoOpenRound`.

- [ ] **Step 4: Commit**

```bash
git add onchain/raider/tests/timecap.ts onchain/raider/tests/raceguard.ts
git commit -m "test(raider): 60s time-cap (outcome=time) + flip-after-settle race guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: crank-probe spike (native ScheduleTask on our devnet validator)

**Files:**
- Create: `spikes/crank-probe/` (minimal Anchor program + driver)

This is a **green/red gate**, not wired into `raider`. It answers the one open question: does the public devnet ER validator `MAS1Dt9…` honor `MagicBlockInstruction::ScheduleTask`?

- [ ] **Step 1: Scaffold the probe from the MagicBlock crank-counter example**

Mirror `magicblock-labs/magicblock-engine-examples/crank-counter`: a tiny program with a `Counter` PDA, an `increment` ix, and a `schedule_increment` ix that CPIs `ScheduleTask` via `ephemeral_rollups_sdk::crank::ScheduleCrankCpi` (confirmed present in 0.15.5: `crank.rs` `ScheduleCrankCpi`/`CancelCrankCpi`; args `ScheduleTaskArgs { task_id, execution_interval_millis, iterations, instructions }`; target `MAGIC_PROGRAM_ID`). Use the same toolchain as `raider` (`~/.avm/bin/anchor-0.32.1`, `ephemeral-rollups-sdk` 0.15.5 `anchor-compat`).

Flow: `initialize` (create Counter) → `delegate` Counter to the ER (validator `MAS1Dt9…`) → `schedule_increment({ taskId: 1, executionIntervalMillis: 200, iterations: 5 })`.

- [ ] **Step 2: Write the driver and observe auto-ticking**

Driver: deploy to devnet, run the flow, then `sleep(2000)` WITHOUT sending any further tx, and read `counter.value`. GREEN iff `value >= 5` (the validator auto-invoked the scheduled `increment` with no client tx).

Run: `cd spikes/crank-probe && <build + deploy + ts-mocha the driver>`
Expected: one of —
- **GREEN:** counter auto-incremented to ≥5; record min `executionIntervalMillis` that still fires, max `iterations`, and who paid (the `ScheduleTask` payer).
- **RED:** counter stayed at 0 / the schedule tx errored — record the error.

- [ ] **Step 3: Record the verdict**

Create `spikes/crank-probe/RESULT.md` with GREEN/RED, the measured interval/iteration limits, the fee payer, and a one-line recommendation (wire the crank in Task 9, or keeper-only).

- [ ] **Step 4: Commit**

```bash
git add spikes/crank-probe
git commit -m "spike(crank-probe): ScheduleTask availability probe on devnet ER validator + verdict

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9 (CONDITIONAL — only if Task 8 is GREEN): wire schedule_tick / cancel_tick

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs`

**Gate:** Implement ONLY if `spikes/crank-probe/RESULT.md` is GREEN. If RED, SKIP this task — the keeper path (Task 4) is the shipped trigger; note "crank deferred, keeper-only" in `RESULT.md` (Task 10) and move on.

- [ ] **Step 1: Add `schedule_tick` and `cancel_tick`**

Using the EXACT `ScheduleCrankCpi`/`CancelCrankCpi` shape the spike confirmed, add a `schedule_tick(ctx, interval_millis, iterations)` that CPIs `ScheduleTask` with a single scheduled instruction = the `tick` ix bound to this round's `[player, house, round, mint, BTC_FEED, caller]` accounts (the validator is the signer/`caller` at execution — `tick` requires no user signature, which is why it is crank-compatible), and a `cancel_tick(ctx, task_id)` that CPIs `CancelTask`. Build the scheduled `Instruction` with `crate::instruction::Tick`-style discriminator + the round's account metas (`ShortAccountMeta`). Follow the spike's working construction verbatim — do NOT guess the account-meta order; copy what the probe proved.

- [ ] **Step 2: Call `schedule_tick` at open / `cancel_tick` at settle**

Either (a) call `schedule_tick` from the driver right after `open` and `cancel_tick` is implicit once `iterations` exhausts (simplest), or (b) CPI `schedule_tick` inside `open` and `cancel_tick` inside `settle_round`. Prefer (a) for Phase 2 (keeps `open`/`settle_round` unchanged and the crank an opt-in driver step); document the choice.

- [ ] **Step 3: Rebuild + deploy + add a crank-driven variant of the tick-liq test**

Add `tests/tick-liq-crank.ts`: same as `tick-liq.ts` but instead of `runKeeper`, call `scheduleTick({ intervalMillis: <spike min>, iterations: 300 })` after open and then just `sleep` + poll `round.status` — no per-tick client tx. Assert the underwater 2000× side liquidates with NO keeper loop running.

Run: `cd onchain/raider && BTC_FEED=... npx ts-mocha -p ./tsconfig.json -t 1000000 tests/tick-liq-crank.ts`
Expected: PASS — liquidation happens with zero client ticks (native crank drove it).

- [ ] **Step 4: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs onchain/raider/tests/tick-liq-crank.ts
git commit -m "feat(raider): schedule_tick/cancel_tick native crank (gated on crank-probe GREEN)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: full suite + RESULT.md

**Files:**
- Modify: `onchain/raider/RESULT.md`

- [ ] **Step 1: Run the full suite (carried Phase-1 + new Phase-2), default build**

Rebuild + deploy the DEFAULT (60s) program. Run the Phase-1 carried tests to confirm no regression:
Run: `cd onchain/raider && BTC_FEED=71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr npx ts-mocha -p ./tsconfig.json -t 1000000 tests/raider.ts tests/forceclose.ts tests/feedauth.ts tests/liq.ts tests/gates.ts`
Expected: all green — `banked` (now in the IDL) defaults to 0 for single-mark rounds, so Phase-1 behavior is unchanged.

- [ ] **Step 2: Run the Phase-2 suite**

Default build for `tick-liq`/`flip`/`lever`; `test-short-deadline` build for `timecap`/`raceguard` (run them in the matching deploy as in Task 7). Confirm all green.

- [ ] **Step 3: Measure continuous-tick latency**

Instrument the keeper loop (or a dedicated `tests/latency-tick.ts`) to record per-`tick` round-trip on the ER (`processed`): submit→confirm. Capture p50/p95 over ≥30 ticks from a real geography (mirror the Phase-1 latency method).

- [ ] **Step 4: Update RESULT.md**

Append a Phase-2 section to `onchain/raider/RESULT.md`: the new verdicts (continuous liq GREEN, flip/lever parity GREEN, time-cap GREEN, race-guard GREEN), the per-tick latency p50/p95, the **crank-probe verdict** (GREEN+wired / RED+keeper-only), the named missed-tick asymmetry (house eats an unobserved dip-recover), and that Phase-1 carried tests still pass.

- [ ] **Step 5: Commit**

```bash
git add onchain/raider/RESULT.md
git commit -m "docs(raider): Phase-2 verdicts — continuous settlement + flip/lever + tick latency + crank verdict

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** banked+live `Round` (T2), `rebank_fp`/banked-`equity_fp`/BigInt parity (T1,T5,T6), `tick` continuous settler liq→cap→time (T1,T4), `flip`/`lever` terminal-first (T5,T6), 60s cap + `force_close` (T2,T3,T7), events/provable trail (T3), hybrid keeper-now (T4) + crank-spike/wiring (T8,T9), solvency-preserved-by-cap-clamp (T1 `cap_clamp` + `settle_round` `.min(max_payout)`), all tests (T4–T7,T10). ✓

**Placeholder scan:** the only intentionally-deferred-to-execution code is Task 9 Step 1 (native-crank account-meta order), which is genuinely spike-gated and explicitly instructed to copy the probe's proven construction — not a hand-wave. Everything else is complete code.

**Type consistency:** `settle::settle(banked, dir, lev, stake, entry, exit)`, `equity_fp(banked, dir, lev, entry, exit)`, `rebank_fp(banked, dir, lev, entry, price)`, `fires(banked, dir, lev, entry, exit, now, deadline)`, `settle_round(player, house, round, snap, now)` — signatures are used identically across T1, T3, T4, T5, T6. `Outcome` codes 0/1/2/3 match the BigInt mirror (cashout/cap/liq) + the new `3=time` (only produced by the `now>=deadline` relabel, never by the mirror's price-only `terminal`, which is correct). `RoundEvent` fields are identical at all four emit sites. `Round.SIZE = 132` matches the field list.
