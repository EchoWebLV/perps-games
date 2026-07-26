# Paddock Race Book Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `paddock` Anchor program — a shared pari-mutuel race book that runs its betting market and settlement inside a MagicBlock Ephemeral Rollup, with the race outcome derived from an authenticated Pyth Lazer price at lock instead of the player's browser.

**Architecture:** One singleton `Race` PDA is permanently delegated to the ER and mutated by many players' `place_bet` calls. A no-signer `race_crank`, armed via MagicBlock's `ScheduleTask`, drives the market → racing → settled → next-race state machine with zero client transactions. Per-player `Bettor` (balance) and `Ticket` (stakes) PDAs are delegated once and reused every race, so nobody pays delegation cost per race. Rake accrues in-rollup and reaches L1 via `commit_accounts` **without** undelegation — a path raider has never used, which is why it is spiked before anything is built.

**Tech Stack:** Anchor 0.32.1, `ephemeral-rollups-sdk` 0.15.5 (`anchor-compat`), `magicblock-magic-program-api` 0.10.1, bincode 1.3, Rust unit tests via `cargo test`, devnet e2e via ts-mocha.

**Scope:** This plan delivers the program only, provable on devnet by a TS driver. Client rewiring of `redline3d/src/ui/bet-panel.ts` and `redline3d/src/render/race-mode.ts` is a **separate plan**, written against the generated IDL after this one lands.

**Spec:** `docs/superpowers/specs/2026-07-27-onchain-race-book-design.md`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `spikes/deleg-probe/programs/deleg-probe/src/lib.rs` | **Throwaway.** Proves multi-payer delegation to one validator + bare `commit_accounts`. Deleted in Task 10. |
| `onchain/raider/programs/paddock/Cargo.toml` | Program manifest. Mirrors raider's dep set. |
| `onchain/raider/programs/paddock/src/state.rs` | `Book`, `Race`, `Bettor`, `Ticket`, seeds, constants. Sizes locked by unit tests. |
| `onchain/raider/programs/paddock/src/book.rs` | Pure pari-mutuel math: rake, `mult_fp`, payout, conservation. No Anchor types. |
| `onchain/raider/programs/paddock/src/draw.rs` | Pure weighted finish-order draw from a 32-byte seed. No Anchor types. |
| `onchain/raider/programs/paddock/src/lib.rs` | Instruction handlers + account contexts. |
| `onchain/raider/tests/paddock.ts` | Devnet e2e driver: full race cycle, two bettors, real payout. |
| `onchain/raider/tests/paddock-helpers.ts` | PDA derivation + a JS mirror of `book.rs` for cross-checking. |

`book.rs` and `draw.rs` are deliberately Anchor-free so they run under plain `cargo test` in milliseconds. That is the fast loop; devnet is the slow loop. Follows the existing split where `settle.rs` holds pure math with `#[cfg(test)]` at `programs/raider/src/settle.rs:331`.

---

## Task 0: Delegation spike (GATE — nothing else starts until this is green)

Two assumptions carry the whole design and neither is proven anywhere in this repo:

1. PDAs delegated by **different payers at different times** are writable in a **single ER transaction**, provided all name the same validator.
2. `commit_accounts` (commit **without** undelegating) works. Raider only ever calls `commit_and_undelegate_accounts` (`programs/raider/src/lib.rs:864`).

If (1) fails the shared-pool design is dead and the spec must be reopened. Prove both on a throwaway program before writing any `paddock` code.

**Files:**
- Create: `spikes/deleg-probe/Anchor.toml`
- Create: `spikes/deleg-probe/Cargo.toml`
- Create: `spikes/deleg-probe/programs/deleg-probe/Cargo.toml`
- Create: `spikes/deleg-probe/programs/deleg-probe/src/lib.rs`
- Create: `spikes/deleg-probe/tests/deleg-probe.ts`

- [ ] **Step 1: Scaffold the spike workspace**

Copy the shape of the existing spike at `spikes/crank-probe/`. Create `spikes/deleg-probe/Cargo.toml`:

```toml
[workspace]
members = ["programs/*"]
resolver = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1
opt-level = "s"
```

Create `spikes/deleg-probe/programs/deleg-probe/Cargo.toml`:

```toml
[package]
name = "deleg-probe"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "deleg_probe"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
idl-build = ["anchor-lang/idl-build"]

[dependencies]
anchor-lang = "0.32.1"
ephemeral-rollups-sdk = { version = "0.15.5", features = ["anchor-compat"] }
```

Create `spikes/deleg-probe/Anchor.toml`:

```toml
[toolchain]
anchor_version = "0.32.1"
package_manager = "yarn"

[features]
resolution = true
skip-lint = false

[programs.devnet]
deleg_probe = "11111111111111111111111111111111"

[provider]
cluster = "devnet"
wallet = "~/.config/solana/lazer-probe.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

- [ ] **Step 2: Write the spike program**

Create `spikes/deleg-probe/programs/deleg-probe/src/lib.rs`:

```rust
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_accounts;

declare_id!("11111111111111111111111111111111");

pub const SHARED_SEED: &[u8] = b"shared";
pub const OWNED_SEED: &[u8] = b"owned";

#[account]
pub struct Shared {
    pub total: u64,
    pub bump: u8,
}
impl Shared {
    pub const SIZE: usize = 8 + 8 + 1;
}

#[account]
pub struct Owned {
    pub owner: Pubkey,
    pub contributed: u64,
    pub bump: u8,
}
impl Owned {
    pub const SIZE: usize = 8 + 32 + 8 + 1;
}

#[ephemeral_rollups_sdk::anchor::ephemeral]
#[program]
pub mod deleg_probe {
    use super::*;

    pub fn init_shared(ctx: Context<InitShared>) -> Result<()> {
        let s = &mut ctx.accounts.shared;
        s.total = 0;
        s.bump = ctx.bumps.shared;
        Ok(())
    }

    pub fn init_owned(ctx: Context<InitOwned>) -> Result<()> {
        let o = &mut ctx.accounts.owned;
        o.owner = ctx.accounts.payer.key();
        o.contributed = 0;
        o.bump = ctx.bumps.owned;
        Ok(())
    }

    /// Delegate the SHARED singleton. Called once, by anyone.
    pub fn delegate_shared(ctx: Context<DelegateShared>) -> Result<()> {
        let validator = ctx.remaining_accounts.first().map(|a| a.key());
        ctx.accounts.delegate_shared(
            &ctx.accounts.payer,
            &[SHARED_SEED],
            DelegateConfig { validator, ..Default::default() },
        )?;
        Ok(())
    }

    /// Delegate ONE player's owned PDA. Called by each player separately, LATER.
    pub fn delegate_owned(ctx: Context<DelegateOwned>) -> Result<()> {
        let owner = ctx.accounts.payer.key();
        let validator = ctx.remaining_accounts.first().map(|a| a.key());
        ctx.accounts.delegate_owned(
            &ctx.accounts.payer,
            &[OWNED_SEED, owner.as_ref()],
            DelegateConfig { validator, ..Default::default() },
        )?;
        Ok(())
    }

    /// THE PROOF for assumption (1): one ER instruction writes a shared PDA
    /// delegated by payer A and an owned PDA delegated by payer B.
    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        ctx.accounts.shared.total = ctx.accounts.shared.total.saturating_add(amount);
        ctx.accounts.owned.contributed =
            ctx.accounts.owned.contributed.saturating_add(amount);
        Ok(())
    }

    /// THE PROOF for assumption (2): commit WITHOUT undelegating. The account
    /// must still be ER-writable afterwards.
    pub fn commit_shared(ctx: Context<CommitShared>) -> Result<()> {
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.shared.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitShared<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = Shared::SIZE, seeds = [SHARED_SEED], bump)]
    pub shared: Account<'info, Shared>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitOwned<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = Owned::SIZE,
              seeds = [OWNED_SEED, payer.key().as_ref()], bump)]
    pub owned: Account<'info, Owned>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateShared<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: delegated PDA
    #[account(mut, del, seeds = [SHARED_SEED], bump)]
    pub shared: AccountInfo<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateOwned<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: delegated PDA
    #[account(mut, del, seeds = [OWNED_SEED, payer.key().as_ref()], bump)]
    pub owned: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SHARED_SEED], bump = shared.bump)]
    pub shared: Account<'info, Shared>,
    #[account(mut, seeds = [OWNED_SEED, owned.owner.as_ref()], bump = owned.bump)]
    pub owned: Account<'info, Owned>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitShared<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SHARED_SEED], bump = shared.bump)]
    pub shared: Account<'info, Shared>,
}
```

- [ ] **Step 3: Generate the program keypair and sync the ID**

```bash
cd spikes/deleg-probe && anchor keys sync && anchor build
```

Expected: build succeeds, and `declare_id!` + `Anchor.toml` now carry a real pubkey instead of `1111...`.

- [ ] **Step 4: Write the spike driver**

Create `spikes/deleg-probe/tests/deleg-probe.ts`:

```ts
const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair } = require("@solana/web3.js");
const { assert } = require("chai");
const {
  BASE_RPC, BASE_WS, ER_RPC, ER_WS, VALIDATOR, sleep, sendIxHttp,
} = require("../../../onchain/raider/tests/helpers");

const DELEGATION_PROGRAM = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);
const idl = require("../target/idl/deleg_probe.json");

describe("deleg-probe", () => {
  let baseConn, erConn, houseKp, playerKp, house, playerER, shared, owned;

  before(async function () {
    this.timeout(180000);
    houseKp = anchor.web3.Keypair.generate(); // delegates `shared`
    playerKp = anchor.web3.Keypair.generate(); // delegates `owned`, LATER

    baseConn = new anchor.web3.Connection(BASE_RPC, {
      commitment: "confirmed", wsEndpoint: BASE_WS,
    });
    erConn = new anchor.web3.Connection(ER_RPC, {
      commitment: "confirmed", wsEndpoint: ER_WS,
    });
    for (const kp of [houseKp, playerKp]) {
      const sig = await baseConn.requestAirdrop(kp.publicKey, 2e9);
      await baseConn.confirmTransaction(sig, "confirmed");
    }

    const mk = (conn, kp) =>
      new anchor.Program(
        idl,
        new anchor.AnchorProvider(conn, new anchor.Wallet(kp), {
          commitment: "confirmed",
        })
      );
    house = mk(baseConn, houseKp);
    const player = mk(baseConn, playerKp);
    playerER = mk(erConn, playerKp);

    const pid = house.programId;
    shared = PublicKey.findProgramAddressSync([Buffer.from("shared")], pid)[0];
    owned = PublicKey.findProgramAddressSync(
      [Buffer.from("owned"), playerKp.publicKey.toBuffer()], pid
    )[0];

    // 1. House inits + delegates the shared singleton.
    await house.methods.initShared().accounts({ payer: houseKp.publicKey }).rpc();
    await sendIxHttp(
      baseConn,
      house.methods.delegateShared()
        .accounts({ payer: houseKp.publicKey })
        .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]),
      houseKp
    );

    // 2. LATER, a DIFFERENT payer inits + delegates their own PDA.
    await sleep(3000);
    await player.methods.initOwned().accounts({ payer: playerKp.publicKey }).rpc();
    await sendIxHttp(
      baseConn,
      player.methods.delegateOwned()
        .accounts({ payer: playerKp.publicKey })
        .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]),
      playerKp
    );

    for (const pda of [shared, owned]) {
      for (let i = 0; i < 25; i++) {
        const info = await baseConn.getAccountInfo(pda);
        if (info && info.owner.equals(DELEGATION_PROGRAM)) break;
        await sleep(1000);
      }
      const info = await baseConn.getAccountInfo(pda);
      assert.isTrue(info.owner.equals(DELEGATION_PROGRAM), "PDA not delegated: " + pda);
    }
  });

  it("ASSUMPTION 1: shared PDA + separately-delegated owned PDA write in ONE ER tx", async function () {
    this.timeout(120000);
    await sendIxHttp(
      erConn,
      playerER.methods.contribute(new anchor.BN(7))
        .accounts({ payer: playerKp.publicKey, shared, owned }),
      playerKp
    );

    const s = await playerER.account.shared.fetch(shared);
    const o = await playerER.account.owned.fetch(owned);
    assert.equal(s.total.toNumber(), 7, "shared not written");
    assert.equal(o.contributed.toNumber(), 7, "owned not written");
  });

  it("ASSUMPTION 2: commit_accounts lands L1 state and leaves the PDA ER-writable", async function () {
    this.timeout(120000);
    const houseER = new anchor.Program(
      idl,
      new anchor.AnchorProvider(erConn, new anchor.Wallet(houseKp), {
        commitment: "confirmed",
      })
    );
    await sendIxHttp(
      erConn,
      houseER.methods.commitShared().accounts({ payer: houseKp.publicKey, shared }),
      houseKp
    );

    // L1 must now see total = 7.
    let l1Total = null;
    for (let i = 0; i < 40; i++) {
      const info = await baseConn.getAccountInfo(shared);
      if (info) {
        // Shared layout: 8-byte disc, u64 total, u8 bump.
        l1Total = info.data.readBigUInt64LE(8);
        if (l1Total === 7n) break;
      }
      await sleep(2000);
    }
    assert.equal(l1Total, 7n, "commit did not land on L1");

    // ...and the account must STILL be delegated (committed, not undelegated).
    const info = await baseConn.getAccountInfo(shared);
    assert.isTrue(
      info.owner.equals(DELEGATION_PROGRAM),
      "commit_accounts undelegated the PDA — it must not"
    );

    // ...and must still be ER-writable.
    await sendIxHttp(
      erConn,
      playerER.methods.contribute(new anchor.BN(7))
        .accounts({ payer: playerKp.publicKey, shared, owned }),
      playerKp
    );
    const s = await playerER.account.shared.fetch(shared);
    assert.equal(s.total.toNumber(), 14, "PDA not writable after commit");
  });
});
```

- [ ] **Step 5: Deploy and run the spike**

```bash
cd spikes/deleg-probe && anchor deploy && anchor test --skip-deploy
```

Expected: both tests pass — `shared.total` 7 then 14, `owned.contributed` 7, and the L1 owner still `DELeGG...` after the commit.

**If ASSUMPTION 1 fails**, STOP. Do not proceed to Task 1. Record the exact error and reopen the spec: the shared-pool design does not work on this validator, and the "player vs house, fixed odds" option from the brainstorm becomes the fallback.

**If ASSUMPTION 2 fails**, `paddock` cannot extract rake without a full undelegate/redelegate cycle. Continue to Task 1 — everything except `commit_race` still holds — but flag it, because Task 9's `commit_race` then needs replacing with an undelegate → sweep → redelegate cycle run between races, which pauses betting.

- [ ] **Step 7: Commit**

```bash
git add spikes/deleg-probe
git commit -m "spike: prove multi-payer ER co-delegation + bare commit_accounts"
```

---

## Task 1: Program scaffold and state

**Files:**
- Create: `onchain/raider/programs/paddock/Cargo.toml`
- Create: `onchain/raider/programs/paddock/src/state.rs`
- Create: `onchain/raider/programs/paddock/src/lib.rs`
- Modify: `onchain/raider/Anchor.toml:11-14`

- [ ] **Step 1: Create the manifest**

Create `onchain/raider/programs/paddock/Cargo.toml`:

```toml
[package]
name = "paddock"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "paddock"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]

[dependencies]
anchor-lang = "0.32.1"
anchor-spl = "0.32.1"
ephemeral-rollups-sdk = { version = "0.15.5", features = ["anchor-compat"] }
magicblock-magic-program-api = "0.10.1"
bincode = "1.3"
```

- [ ] **Step 2: Write the failing size tests**

Create `onchain/raider/programs/paddock/src/state.rs` with only the constants, structs, and this test module — the structs come in Step 4:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_sizes_are_locked() {
        assert_eq!(Book::SIZE, 89);
        assert_eq!(Bettor::SIZE, 81);
        assert_eq!(Ticket::SIZE, 113);
        assert_eq!(Race::SIZE, 778);
    }

    #[test]
    fn race_fits_in_one_account_realloc_free() {
        // 10 KiB is the CPI-safe ceiling for account creation without realloc.
        assert!(Race::SIZE < 10_240);
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd onchain/raider && cargo test -p paddock`
Expected: FAIL — `cannot find type Book in this scope` (and the same for the other three).

- [ ] **Step 4: Write the state**

Prepend to `onchain/raider/programs/paddock/src/state.rs`:

```rust
use anchor_lang::prelude::*;

// PDA seeds. `book`/`race` are singletons per mint; `bettor`/`ticket` are per player.
pub const BOOK_SEED: &[u8] = b"book";
pub const RACE_SEED: &[u8] = b"race";
pub const BETTOR_SEED: &[u8] = b"bettor";
pub const TICKET_SEED: &[u8] = b"ticket";
pub const VAULT_SEED: &[u8] = b"vault";

pub const GRID: usize = 8;
pub const HISTORY_LEN: usize = 32;

// Phase durations. RACE_SECS exceeds the client's own worst case (last place
// finishes at 30 + 7*0.8 + rng*0.4 ~= 36.0s, redline3d/src/render/race-mode.ts:351)
// so the chain sets the window and the client renders inside it.
pub const MARKET_SECS: i64 = 15;
pub const RACE_SECS: i64 = 40;
pub const FINISH_SECS: i64 = 6;

// Reject prices older than this, matching raider's state.rs:71.
pub const STALE_SECS: i64 = 30;

// Phase codes.
pub const PHASE_MARKET: u8 = 0;
pub const PHASE_RACING: u8 = 1;
pub const PHASE_SETTLED: u8 = 2;

/// House bankroll + rake sink. Same layout as raider's HouseBalance so the
/// vault/deposit/withdraw plumbing transfers unchanged.
#[account]
pub struct Book {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub balance: u64,
    pub locked: u64,
    pub bump: u8,
}
impl Book {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

/// Per-player play balance. Same layout as raider's PlayerBalance.
#[account]
pub struct Bettor {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub balance: u64,
    pub bump: u8,
}
impl Bettor {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 1;
}

/// One player's stakes in the CURRENT race. Seeds deliberately carry no race id:
/// the player delegates once and reuses this every race. Staleness is detected by
/// comparing `race_seq` against the live Race, mirroring the round-corpse
/// reconciliation in redline3d/src/chain/game-session.ts:385.
#[account]
pub struct Ticket {
    pub owner: Pubkey,
    pub race_seq: u64,
    pub stakes: [u64; GRID],
    pub bump: u8,
}
impl Ticket {
    pub const SIZE: usize = 8 + 32 + 8 + 8 * GRID + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct RaceResult {
    pub seq: u64,
    pub winner: u8,
    pub mult_fp: u64,
}
impl RaceResult {
    pub const SIZE: usize = 8 + 1 + 8;
}

/// The singleton live race. Delegated once, permanently; never undelegated.
#[account]
pub struct Race {
    pub mint: Pubkey,
    pub seq: u64,
    pub phase: u8,
    pub phase_ends_ts: i64,
    pub entrants: [u8; GRID],
    pub strengths: [u16; GRID],
    pub pools: [u64; GRID],
    pub total: u64,
    pub order: [u8; GRID],
    pub seed: [u8; 32],
    pub feed: Pubkey,
    pub rake_accrued: u64,
    pub history: [RaceResult; HISTORY_LEN],
    pub bump: u8,
}
impl Race {
    pub const SIZE: usize = 8
        + 32                        // mint
        + 8                         // seq
        + 1                         // phase
        + 8                         // phase_ends_ts
        + GRID                      // entrants
        + 2 * GRID                  // strengths
        + 8 * GRID                  // pools
        + 8                         // total
        + GRID                      // order
        + 32                        // seed
        + 32                        // feed
        + 8                         // rake_accrued
        + HISTORY_LEN * RaceResult::SIZE
        + 1; // bump

    /// Slot-keyed ring lookup: O(1), and staleness is self-evident — if
    /// `history[seq % HISTORY_LEN].seq != seq` that race has been overwritten.
    /// Race 0 is indistinguishable from the zero-initialised ring, so it is
    /// deliberately never settled: `init_race` starts at seq 0 and the first
    /// settlement the crank writes is for seq 0 with a real `mult_fp`. Guard by
    /// requiring a non-sentinel ticket (`race_seq != u64::MAX`) at every caller.
    pub fn find_result(&self, seq: u64) -> Option<&RaceResult> {
        let slot = (seq as usize) % HISTORY_LEN;
        let r = &self.history[slot];
        if r.seq == seq {
            Some(r)
        } else {
            None
        }
    }

    /// Push a result into the ring at the slot keyed by seq.
    pub fn push_result(&mut self, r: RaceResult) {
        let slot = (r.seq as usize) % HISTORY_LEN;
        self.history[slot] = r;
    }
}
```

- [ ] **Step 5: Add the minimal lib.rs so the crate compiles**

Create `onchain/raider/programs/paddock/src/lib.rs`:

```rust
use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

pub mod book;
pub mod draw;
pub mod state;

#[program]
pub mod paddock {
    use super::*;
}
```

Create empty `book.rs` and `draw.rs` containing only `#![allow(dead_code)]` for now so the `mod` declarations resolve.

- [ ] **Step 6: Run the tests**

Run: `cd onchain/raider && cargo test -p paddock`
Expected: PASS, 2 tests.

If `Race::SIZE` mismatches 778, fix the **assertion** to the computed value and record the new number — do not pad the struct.

- [ ] **Step 7: Register the program and generate its ID**

Add to `onchain/raider/Anchor.toml` under `[programs.devnet]`:

```toml
paddock = "11111111111111111111111111111111"
```

Run: `cd onchain/raider && anchor keys sync && anchor build`
Expected: `declare_id!` and `Anchor.toml` both carry the real generated pubkey.

- [ ] **Step 8: Commit**

```bash
git add onchain/raider/programs/paddock onchain/raider/Anchor.toml
git commit -m "paddock: program scaffold + Book/Race/Bettor/Ticket state"
```

---

## Task 2: Pari-mutuel settlement math

Pure integer math, no Anchor types, so it runs under `cargo test` in milliseconds.

**Files:**
- Modify: `onchain/raider/programs/paddock/src/book.rs`

- [ ] **Step 1: Write the failing tests**

Replace the contents of `onchain/raider/programs/paddock/src/book.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rake_is_five_percent() {
        let s = settle_pool(1_000_000, 400_000);
        assert_eq!(s.rake, 50_000);
    }

    #[test]
    fn winner_pool_splits_the_payable_remainder() {
        // total 1_000_000, rake 50_000, payable 950_000, winner pool 400_000
        // mult = 950_000 * 1e6 / 400_000 = 2_375_000 (2.375x)
        let s = settle_pool(1_000_000, 400_000);
        assert_eq!(s.mult_fp, 2_375_000);
        assert_eq!(payout_of(400_000, s.mult_fp), 950_000);
    }

    #[test]
    fn nobody_backed_the_winner_gives_the_whole_pool_to_the_house() {
        let s = settle_pool(1_000_000, 0);
        assert_eq!(s.mult_fp, 0);
        assert_eq!(s.rake, 1_000_000);
        assert_eq!(payout_of(0, s.mult_fp), 0);
    }

    #[test]
    fn empty_race_settles_to_zero() {
        let s = settle_pool(0, 0);
        assert_eq!(s.mult_fp, 0);
        assert_eq!(s.rake, 0);
    }

    #[test]
    fn payouts_never_exceed_payable_under_rounding() {
        // Three uneven stakes on the winner; floor-division must leave the house
        // whole, never short. This is the conservation property that matters.
        let stakes = [333_333u64, 333_333, 333_334];
        let winner_pool: u64 = stakes.iter().sum();
        let total = winner_pool + 500_000; // losers' money
        let s = settle_pool(total, winner_pool);
        let paid: u64 = stakes.iter().map(|&st| payout_of(st, s.mult_fp)).sum();
        assert!(paid <= total - s.rake, "paid {} > payable {}", paid, total - s.rake);
    }

    #[test]
    fn a_lone_winner_takes_the_whole_payable_pool() {
        let s = settle_pool(1_000_000, 100);
        assert_eq!(payout_of(100, s.mult_fp), 950_000);
    }

    #[test]
    fn large_pools_do_not_overflow() {
        let total = u64::MAX / 4;
        let s = settle_pool(total, total / 2);
        assert!(s.mult_fp > 0);
        assert!(payout_of(total / 2, s.mult_fp) <= total - s.rake);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd onchain/raider && cargo test -p paddock book`
Expected: FAIL — `cannot find function settle_pool in this scope`.

- [ ] **Step 3: Implement**

Prepend to `onchain/raider/programs/paddock/src/book.rs`:

```rust
//! Pure pari-mutuel math. No Anchor types — runs under plain `cargo test`.
//!
//! All division floors, which is house-favorable: the sum of floored payouts can
//! only ever be <= the payable pool, never more. `payouts_never_exceed_payable`
//! locks that property.

pub const SCALE: u64 = 1_000_000;
/// 5% rake, matching RAKE in redline3d/src/core/race-payout.ts (locked by
/// race-payout.test.ts).
pub const RAKE_FP: u64 = 50_000;

pub struct Settlement {
    pub mult_fp: u64,
    pub rake: u64,
}

/// Split `total` into rake and a per-unit multiplier for stakes on the winner.
pub fn settle_pool(total: u64, winner_pool: u64) -> Settlement {
    if winner_pool == 0 {
        // Nobody backed the winner. There are no stakes to divide by and no claim
        // can reference this race, so the house takes the pool. Explicit branch,
        // not an accidental divide-by-zero.
        return Settlement { mult_fp: 0, rake: total };
    }
    let rake = ((total as u128) * (RAKE_FP as u128) / (SCALE as u128)) as u64;
    let payable = total - rake;
    let mult_fp = ((payable as u128) * (SCALE as u128) / (winner_pool as u128)) as u64;
    Settlement { mult_fp, rake }
}

/// One bettor's gross payout for `stake` on the winning car.
pub fn payout_of(stake: u64, mult_fp: u64) -> u64 {
    ((stake as u128) * (mult_fp as u128) / (SCALE as u128)) as u64
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd onchain/raider && cargo test -p paddock book`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add onchain/raider/programs/paddock/src/book.rs
git commit -m "paddock: pari-mutuel settlement math with conservation tests"
```

---

## Task 3: Weighted finish-order draw

Replaces the client's `mulberry32(seed)` + `OUTCOME_NOISE` scoring at
`redline3d/src/render/race-mode.ts:342-359`. Weighted sampling without replacement
gives upsets naturally: a strength-1000 car among ~14000 total weight wins roughly
7% of the time, which is the same flavor of upset `OUTCOME_NOISE = 2.8` produced.

**Files:**
- Modify: `onchain/raider/programs/paddock/src/draw.rs`

- [ ] **Step 1: Write the failing tests**

Replace the contents of `onchain/raider/programs/paddock/src/draw.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const EVEN: [u16; 8] = [1000; 8];
    const LADDER: [u16; 8] = [1000, 1000, 1350, 1350, 1800, 1800, 2400, 3200];

    fn seed_of(n: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = n;
        s
    }

    #[test]
    fn output_is_a_permutation_of_all_eight_cars() {
        for n in 0..50u8 {
            let order = draw_order(&seed_of(n), &LADDER);
            let mut seen = [false; 8];
            for &car in order.iter() {
                assert!((car as usize) < 8, "car index out of range: {}", car);
                assert!(!seen[car as usize], "car {} appeared twice", car);
                seen[car as usize] = true;
            }
        }
    }

    #[test]
    fn same_seed_gives_the_same_order() {
        let a = draw_order(&seed_of(7), &LADDER);
        let b = draw_order(&seed_of(7), &LADDER);
        assert_eq!(a, b);
    }

    #[test]
    fn different_seeds_give_different_orders() {
        let a = draw_order(&seed_of(1), &LADDER);
        let b = draw_order(&seed_of(2), &LADDER);
        assert_ne!(a, b);
    }

    #[test]
    fn stronger_cars_win_more_often() {
        let mut wins = [0u32; 8];
        for n in 0..=255u8 {
            wins[draw_order(&seed_of(n), &LADDER)[0] as usize] += 1;
        }
        // car 7 (strength 3200) must beat car 0 (strength 1000) over 256 draws
        assert!(wins[7] > wins[0], "wins: {:?}", wins);
    }

    #[test]
    fn the_weakest_car_still_wins_sometimes() {
        let mut weak_wins = 0;
        for n in 0..=255u8 {
            if draw_order(&seed_of(n), &LADDER)[0] == 0 {
                weak_wins += 1;
            }
        }
        assert!(weak_wins > 0, "a rarity-1 car must be able to upset");
    }

    #[test]
    fn equal_strengths_still_produce_a_valid_permutation() {
        let order = draw_order(&seed_of(3), &EVEN);
        let mut sorted = order;
        sorted.sort();
        assert_eq!(sorted, [0, 1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn all_zero_strengths_do_not_panic() {
        let order = draw_order(&seed_of(3), &[0u16; 8]);
        let mut sorted = order;
        sorted.sort();
        assert_eq!(sorted, [0, 1, 2, 3, 4, 5, 6, 7]);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd onchain/raider && cargo test -p paddock draw`
Expected: FAIL — `cannot find function draw_order in this scope`.

- [ ] **Step 3: Implement**

Prepend to `onchain/raider/programs/paddock/src/draw.rs`:

```rust
//! Weighted finish-order draw. Pure — no Anchor account types — so it runs under
//! plain `cargo test`.
//!
//! Weighted sampling WITHOUT replacement: each rank draws from the remaining
//! cars in proportion to strength. Upsets fall out of the weighting, so there is
//! no separate noise term to tune.

use anchor_lang::solana_program::keccak;

use crate::state::GRID;

/// Deterministic 64-bit draw `counter` from `seed`.
fn next_u64(seed: &[u8; 32], counter: u64) -> u64 {
    let h = keccak::hashv(&[seed, &counter.to_le_bytes()]);
    u64::from_le_bytes(h.0[..8].try_into().expect("keccak output is 32 bytes"))
}

/// Produce the finish order: `order[0]` is the winner, `order[7]` is last.
pub fn draw_order(seed: &[u8; 32], strengths: &[u16; GRID]) -> [u8; GRID] {
    let mut remaining: [u8; GRID] = [0, 1, 2, 3, 4, 5, 6, 7];
    let mut n = GRID;
    let mut order = [0u8; GRID];

    for rank in 0..GRID {
        let total: u64 = remaining[..n]
            .iter()
            .map(|&i| strengths[i as usize] as u64)
            .sum();

        // With all-zero strengths every car is equally (un)likely; fall through to
        // the last remaining index rather than dividing by zero.
        let r = if total == 0 {
            0
        } else {
            next_u64(seed, rank as u64) % total
        };

        let mut acc = 0u64;
        let mut pick = n - 1;
        for k in 0..n {
            acc += strengths[remaining[k] as usize] as u64;
            if r < acc {
                pick = k;
                break;
            }
        }

        order[rank] = remaining[pick];
        // Swap-remove keeps this allocation-free and deterministic.
        remaining[pick] = remaining[n - 1];
        n -= 1;
    }

    order
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd onchain/raider && cargo test -p paddock draw`
Expected: PASS, 7 tests.

If `different_seeds_give_different_orders` fails, pick two other seed bytes — with 8! = 40320 permutations a collision on a specific pair is possible and is not a bug.

- [ ] **Step 5: Commit**

```bash
git add onchain/raider/programs/paddock/src/draw.rs
git commit -m "paddock: weighted finish-order draw from a 32-byte seed"
```

---

## Task 4: Seed derivation from the Lazer price

**Files:**
- Create: `onchain/raider/programs/paddock/src/price.rs`
- Modify: `onchain/raider/programs/paddock/src/lib.rs:5`
- Modify: `onchain/raider/programs/paddock/src/draw.rs`

- [ ] **Step 1: Copy the price decoder**

Copy `onchain/raider/programs/raider/src/price.rs` verbatim to
`onchain/raider/programs/paddock/src/price.rs`. Then fix the two references that
point at raider's crate:

- `crate::state::STALE_SECS` already resolves — `paddock::state::STALE_SECS` was defined in Task 1.
- Replace `RaiderError::UntrustedFeed` / `RaiderError::StalePrice` with `PaddockError::UntrustedFeed` / `PaddockError::StalePrice` (added in Task 5).

This is a deliberate copy, not a shared crate: the decoder is 160 lines with no
dependencies, and coupling two deployed programs through a shared module would
mean a raider redeploy every time paddock changes.

- [ ] **Step 2: Write the failing seed test**

Append to `onchain/raider/programs/paddock/src/draw.rs` inside `mod tests`:

```rust
    #[test]
    fn seed_binds_sequence_price_and_timestamp() {
        let a = race_seed(1, 65_000_00000000, 1_770_000_000);
        let b = race_seed(2, 65_000_00000000, 1_770_000_000);
        let c = race_seed(1, 65_000_00000001, 1_770_000_000);
        let d = race_seed(1, 65_000_00000000, 1_770_000_001);
        assert_ne!(a, b, "seq must change the seed");
        assert_ne!(a, c, "price must change the seed");
        assert_ne!(a, d, "publish time must change the seed");
    }

    #[test]
    fn seed_is_reproducible() {
        assert_eq!(
            race_seed(9, 123_456, 1_770_000_000),
            race_seed(9, 123_456, 1_770_000_000)
        );
    }
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd onchain/raider && cargo test -p paddock draw`
Expected: FAIL — `cannot find function race_seed in this scope`.

- [ ] **Step 4: Implement**

Append to the non-test portion of `onchain/raider/programs/paddock/src/draw.rs`:

```rust
/// Seed for race `seq`, bound to the authenticated Lazer price read at lock.
///
/// The market opens with `Race.seed` all zeroes; this value only exists once the
/// crank locks the market, so the winner cannot be known while bets are open —
/// the structural fix for the client-side pre-decided outcome at
/// redline3d/src/render/race-mode.ts:363.
pub fn race_seed(seq: u64, price_raw: i64, publish_time: i64) -> [u8; 32] {
    keccak::hashv(&[
        &seq.to_le_bytes(),
        &price_raw.to_le_bytes(),
        &publish_time.to_le_bytes(),
    ])
    .0
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd onchain/raider && cargo test -p paddock`
Expected: PASS, all tests across `state`, `book`, `draw`.

- [ ] **Step 6: Commit**

```bash
git add onchain/raider/programs/paddock/src/price.rs onchain/raider/programs/paddock/src/draw.rs
git commit -m "paddock: Lazer price decoder + race seed derivation"
```

---

## Task 5: L1 instructions — book, vault, deposit, withdraw

These are near-copies of raider's proven vault path (`init_house` at
`programs/raider/src/lib.rs:100`, `buy_in` at `:140`, `withdraw` at `:172`).

**Files:**
- Modify: `onchain/raider/programs/paddock/src/lib.rs`

- [ ] **Step 1: Write the handlers**

Replace `onchain/raider/programs/paddock/src/lib.rs` with:

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// Keep the placeholder from Task 1; `anchor keys sync` rewrote it to the real
// generated pubkey there. Do not hand-edit this string.
declare_id!("11111111111111111111111111111111");

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
```

- [ ] **Step 2: Build**

Run: `cd onchain/raider && anchor build -p paddock`
Expected: compiles clean. Fix any `PaddockError` variants `price.rs` needs that are missing.

- [ ] **Step 3: Commit**

```bash
git add onchain/raider/programs/paddock/src/lib.rs
git commit -m "paddock: L1 book init, join, deposit, withdraw"
```

---

## Task 6: Race init and delegation

**Files:**
- Modify: `onchain/raider/programs/paddock/src/lib.rs`

- [ ] **Step 1: Add init_race, delegate_race, delegate_bettor**

Add these imports at the top of `lib.rs`:

```rust
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
```

Add inside `pub mod paddock`:

```rust
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
```

Add the contexts:

```rust
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
```

- [ ] **Step 2: Build**

Run: `cd onchain/raider && anchor build -p paddock`
Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add onchain/raider/programs/paddock/src/lib.rs
git commit -m "paddock: race init + shared/per-player delegation"
```

---

## Task 7: ER instruction — place_bet

**Files:**
- Modify: `onchain/raider/programs/paddock/src/lib.rs`

- [ ] **Step 1: Add the handler**

Add inside `pub mod paddock`:

```rust
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
        require!(bettor.balance >= amount, PaddockError::InsufficientBalance);

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
```

Add this free function at the bottom of `lib.rs`, outside the `#[program]` module:

```rust
/// Payout owed to `ticket` for the race it currently references, or 0 if that
/// race has aged out of the ring, was never settled, or the ticket had no stake
/// on the winner. Idempotent by construction: callers zero `stakes` afterwards.
fn settle_ticket(race: &Race, ticket: &Ticket) -> u64 {
    let Some(result) = race.find_result(ticket.race_seq) else {
        return 0;
    };
    book::payout_of(ticket.stakes[result.winner as usize], result.mult_fp)
}
```

Add the context:

```rust
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
```

- [ ] **Step 2: Build**

Run: `cd onchain/raider && anchor build -p paddock`
Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add onchain/raider/programs/paddock/src/lib.rs
git commit -m "paddock: place_bet with stale-ticket auto-settle"
```

---

## Task 8: ER instruction — race_crank state machine

**Files:**
- Modify: `onchain/raider/programs/paddock/src/lib.rs`

- [ ] **Step 1: Add the crank**

Add inside `pub mod paddock`:

```rust
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
                // cannot be known while bets are open.
                let snap = price::read_fresh(&ctx.accounts.price_update, now)?;
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
                race.push_result(state::RaceResult {
                    seq: race.seq,
                    winner,
                    mult_fp: s.mult_fp,
                });
                race.phase = state::PHASE_SETTLED;
                race.phase_ends_ts = now + state::FINISH_SECS;
            }
            state::PHASE_SETTLED => {
                // Roll to the next race. The grid re-rolls from the settled seed so
                // entrants are unpredictable too, without another price read.
                let next = race.seq + 1;
                let grid_seed = draw::race_seed(next, 0, 0);
                let shuffled = draw::draw_order(&grid_seed, &race.strengths);
                race.seq = next;
                race.entrants = shuffled;
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
```

Add the context:

```rust
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
```

- [ ] **Step 2: Build**

Run: `cd onchain/raider && anchor build -p paddock`
Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add onchain/raider/programs/paddock/src/lib.rs
git commit -m "paddock: no-signer race_crank driving market/racing/settled/roll"
```

---

## Task 9: ER instructions — claim, commit_race, and crank arming

**Files:**
- Modify: `onchain/raider/programs/paddock/src/lib.rs`

- [ ] **Step 1: Add claim and commit_race**

Add the import:

```rust
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
```

Add inside `pub mod paddock`:

```rust
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

    /// Land the Race's ER state on L1 WITHOUT undelegating, and zero the accrued
    /// rake so it is only ever counted once. Permissionless.
    ///
    /// Race is permanently delegated, so raider's commit-once-at-session-end model
    /// does not apply — without this, rake would be stranded in the rollup forever.
    /// Doubles as the audit trail: each commit publishes the history ring to L1.
    pub fn commit_race(ctx: Context<CommitRace>) -> Result<()> {
        let swept = ctx.accounts.race.rake_accrued;
        ctx.accounts.race.rake_accrued = 0;
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.race.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        msg!("committed race with {} rake swept", swept);
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
```

Add the contexts:

```rust
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
```

- [ ] **Step 2: Add schedule_race_crank**

Add these imports:

```rust
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
use magicblock_magic_program_api::args::ScheduleTaskArgs;
use magicblock_magic_program_api::instruction::MagicBlockInstruction;
```

Add inside `pub mod paddock`:

```rust
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
```

Add the context. `race` is typed and `mut` for the same reason raider's `ScheduleTick`
does it (`programs/raider/src/lib.rs:1436`): the scheduled writable meta must inherit
write privilege or the scheduler rejects the task with `PrivilegeEscalation`.

```rust
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
```

- [ ] **Step 3: Build and run all unit tests**

Run: `cd onchain/raider && anchor build -p paddock && cargo test -p paddock`
Expected: build clean, all unit tests pass.

- [ ] **Step 4: Commit**

```bash
git add onchain/raider/programs/paddock/src/lib.rs
git commit -m "paddock: claim, commit_race rake sweep, exit_bettor, crank arming"
```

---

## Task 10: Devnet end-to-end driver

The real proof: two independent wallets bet on one shared pool, the crank runs the
whole cycle unattended, and the winner's payout matches the JS mirror to the unit.

**Files:**
- Create: `onchain/raider/tests/paddock-helpers.ts`
- Create: `onchain/raider/tests/paddock.ts`
- Delete: `spikes/deleg-probe/`

- [ ] **Step 1: Write the helpers + JS mirror**

Create `onchain/raider/tests/paddock-helpers.ts`:

```ts
// PDA derivation + a BigInt mirror of book.rs, so the driver settles against the
// SAME definitions the program uses. Mirrors the shape of tests/helpers.ts.
const { PublicKey } = require("@solana/web3.js");

const SCALE = 1_000_000n;
const RAKE_FP = 50_000n;

// Mirror of book::settle_pool — truncating BigInt division matches Rust u128.
function settlePool(total, winnerPool) {
  const t = BigInt(total), w = BigInt(winnerPool);
  if (w === 0n) return { multFp: 0n, rake: t };
  const rake = (t * RAKE_FP) / SCALE;
  const payable = t - rake;
  return { multFp: (payable * SCALE) / w, rake };
}

// Mirror of book::payout_of.
const payoutOf = (stake, multFp) => (BigInt(stake) * BigInt(multFp)) / SCALE;

const deriveBook = (pid, mint) =>
  PublicKey.findProgramAddressSync([Buffer.from("book"), mint.toBuffer()], pid)[0];
const deriveRace = (pid, mint) =>
  PublicKey.findProgramAddressSync([Buffer.from("race"), mint.toBuffer()], pid)[0];
const deriveBettor = (pid, owner, mint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("bettor"), owner.toBuffer(), mint.toBuffer()], pid
  )[0];
const deriveTicket = (pid, owner, mint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), owner.toBuffer(), mint.toBuffer()], pid
  )[0];
const deriveVault = (pid, mint) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], pid)[0];

module.exports = {
  SCALE, RAKE_FP, settlePool, payoutOf,
  deriveBook, deriveRace, deriveBettor, deriveTicket, deriveVault,
};
```

- [ ] **Step 2: Write the e2e driver**

Uses a fresh 6-decimal test mint rather than wSOL, matching the hermetic pattern in
`tests/deposit.ts:44`. Raider already proves the wSOL path; this driver's job is the
shared pool, not token wrapping.

Create `onchain/raider/tests/paddock.ts`:

```ts
// Paddock e2e: two independent wallets bet into ONE shared pari-mutuel pool, the
// native crank runs the whole cycle unattended, and the payout matches the JS
// mirror of book.rs to the unit.
const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const {
  createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync,
  mintTo, getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const assert = require("assert");
const idl = require("../target/idl/paddock.json");
const {
  BASE_RPC, BASE_WS, ER_RPC, ER_WS, BTC_FEED, VALIDATOR, sleep, sendIxHttp,
} = require("./helpers");
const {
  settlePool, payoutOf, deriveBook, deriveRace, deriveBettor, deriveTicket, deriveVault,
} = require("./paddock-helpers");
const { BN } = anchor;

const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const STRENGTHS = [1000, 1000, 1350, 1350, 1800, 1800, 2400, 3200];
const ENTRANTS = [0, 1, 2, 3, 4, 5, 6, 7];
const STAKE_A = 300_000; // on car 0 (weakest)
const STAKE_B = 700_000; // on car 7 (strongest)
const CAR_A = 0, CAR_B = 7;

describe("paddock shared-pool race book", function () {
  this.timeout(1_000_000);

  const houseWallet = anchor.Wallet.local(); // ANCHOR_WALLET pays for everything
  const baseConn = new anchor.web3.Connection(BASE_RPC, {
    commitment: "confirmed", wsEndpoint: BASE_WS,
  });
  const erConn = new anchor.web3.Connection(ER_RPC, {
    commitment: "confirmed", wsEndpoint: ER_WS,
  });

  const mkProgram = (conn, kp) =>
    new anchor.Program(
      idl,
      new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" })
    );

  const kpA = Keypair.generate();
  const kpB = Keypair.generate();
  let mint, pid, bookPda, racePda, vaultAuthority, vaultToken;
  let house, houseER, aER, bER, aBase, bBase;
  let bettorA, bettorB, ticketA, ticketB, ataA, ataB;

  before(async () => {
    house = mkProgram(baseConn, houseWallet.payer);
    houseER = mkProgram(erConn, houseWallet.payer);
    pid = house.programId;

    // Fund A and B from the local wallet (devnet airdrops are rate-limited).
    const fundTx = new anchor.web3.Transaction();
    for (const kp of [kpA, kpB]) {
      fundTx.add(SystemProgram.transfer({
        fromPubkey: houseWallet.publicKey,
        toPubkey: kp.publicKey,
        lamports: 0.2 * LAMPORTS_PER_SOL,
      }));
    }
    await house.provider.sendAndConfirm(fundTx);

    mint = await createMint(baseConn, houseWallet.payer, houseWallet.publicKey, null, 6);
    bookPda = deriveBook(pid, mint);
    racePda = deriveRace(pid, mint);
    vaultAuthority = deriveVault(pid, mint);
    vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);

    aBase = mkProgram(baseConn, kpA);
    bBase = mkProgram(baseConn, kpB);
    aER = mkProgram(erConn, kpA);
    bER = mkProgram(erConn, kpB);

    for (const [kp, prog] of [[kpA, aBase], [kpB, bBase]]) {
      const ata = await getOrCreateAssociatedTokenAccount(
        baseConn, houseWallet.payer, mint, kp.publicKey
      );
      await mintTo(baseConn, houseWallet.payer, mint, ata.address, houseWallet.payer, 5_000_000);
      if (kp === kpA) ataA = ata.address; else ataB = ata.address;
    }
    bettorA = deriveBettor(pid, kpA.publicKey, mint);
    bettorB = deriveBettor(pid, kpB.publicKey, mint);
    ticketA = deriveTicket(pid, kpA.publicKey, mint);
    ticketB = deriveTicket(pid, kpB.publicKey, mint);

    // House: book + race, pinned to the BTC Lazer feed.
    await house.methods.initBook()
      .accounts({
        authority: houseWallet.publicKey, mint, book: bookPda,
        vaultAuthority, vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();
    await house.methods.initRace(ENTRANTS, STRENGTHS)
      .accounts({
        authority: houseWallet.publicKey, mint, race: racePda,
        priceUpdate: BTC_FEED, systemProgram: SystemProgram.programId,
      }).rpc();

    // Delegate the SHARED race first, by the house.
    await sendIxHttp(
      baseConn,
      house.methods.delegateRace()
        .accounts({ payer: houseWallet.publicKey, mint, race: racePda })
        .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]),
      houseWallet.payer
    );

    // LATER, and by DIFFERENT payers: each bettor joins, deposits, delegates.
    for (const [kp, prog, bettor, ticket, ata] of [
      [kpA, aBase, bettorA, ticketA, ataA],
      [kpB, bBase, bettorB, ticketB, ataB],
    ]) {
      await prog.methods.join()
        .accounts({ payer: kp.publicKey, mint, bettor, ticket,
                    systemProgram: SystemProgram.programId }).rpc();
      await prog.methods.deposit(new BN(2_000_000))
        .accounts({ owner: kp.publicKey, mint, bettor, ownerToken: ata,
                    vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
      await sendIxHttp(
        baseConn,
        prog.methods.delegateBettor()
          .accounts({ payer: kp.publicKey, mint, bettor, ticket })
          .remainingAccounts([{ pubkey: VALIDATOR, isSigner: false, isWritable: false }]),
        kp
      );
    }

    for (const pda of [racePda, bettorA, bettorB, ticketA, ticketB]) {
      for (let i = 0; i < 30; i++) {
        const info = await baseConn.getAccountInfo(pda);
        if (info && info.owner.equals(DELEGATION_PROGRAM)) break;
        await sleep(1000);
      }
      const info = await baseConn.getAccountInfo(pda);
      assert.ok(info.owner.equals(DELEGATION_PROGRAM), "not delegated: " + pda.toBase58());
    }

    // Arm the native crank from inside the ER.
    await sendIxHttp(
      erConn,
      houseER.methods.scheduleRaceCrank(new BN(Date.now() % 1e9), new BN(1000), new BN(300))
        .accounts({
          magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"),
          payer: houseWallet.publicKey, race: racePda, priceUpdate: BTC_FEED,
        }),
      houseWallet.payer
    );
  });

  // Wait for a market phase with enough runway left to place two bets.
  async function waitForOpenMarket(minSecsLeft) {
    for (let i = 0; i < 180; i++) {
      const r = await houseER.account.race.fetch(racePda);
      const now = Math.floor(Date.now() / 1000);
      if (r.phase === 0 && r.phaseEndsTs.toNumber() - now > minSecsLeft) return r;
      await sleep(1000);
    }
    throw new Error("no open market with runway within 180s");
  }

  let bettingSeq;

  it("two separately-delegated wallets bet into ONE shared pool concurrently", async () => {
    const before = await waitForOpenMarket(6);
    bettingSeq = before.seq.toNumber();

    // Concurrent — this is also the write-contention check (spec risk 2). If the
    // ER dropped either update, `total` would be short.
    await Promise.all([
      sendIxHttp(erConn, aER.methods.placeBet(CAR_A, new BN(STAKE_A))
        .accounts({ payer: kpA.publicKey, mint, race: racePda,
                    bettor: bettorA, ticket: ticketA }), kpA),
      sendIxHttp(erConn, bER.methods.placeBet(CAR_B, new BN(STAKE_B))
        .accounts({ payer: kpB.publicKey, mint, race: racePda,
                    bettor: bettorB, ticket: ticketB }), kpB),
    ]);

    const r = await houseER.account.race.fetch(racePda);
    assert.equal(r.seq.toNumber(), bettingSeq, "race rolled mid-bet; rerun");
    assert.equal(r.pools[CAR_A].toNumber(), STAKE_A, "A's stake missing");
    assert.equal(r.pools[CAR_B].toNumber(), STAKE_B, "B's stake missing");
    assert.equal(r.total.toNumber(), STAKE_A + STAKE_B, "lost update under contention");
    assert.deepEqual([...r.seed], new Array(32).fill(0), "seed must not exist during betting");
  });

  it("the crank locks, settles, and the multiplier matches the JS mirror exactly", async () => {
    let settled = null;
    for (let i = 0; i < 180; i++) {
      const r = await houseER.account.race.fetch(racePda);
      const slot = bettingSeq % 32;
      if (r.history[slot].seq.toNumber() === bettingSeq && r.seq.toNumber() >= bettingSeq) {
        // Only trust the record once the racing phase has actually completed.
        if (r.phase === 2 || r.seq.toNumber() > bettingSeq) { settled = r; break; }
      }
      await sleep(1000);
    }
    assert.ok(settled, "race did not settle within 180s");

    const rec = settled.history[bettingSeq % 32];
    const winner = rec.winner;
    const winnerPool = winner === CAR_A ? STAKE_A : winner === CAR_B ? STAKE_B : 0;
    const expected = settlePool(STAKE_A + STAKE_B, winnerPool);
    assert.equal(
      rec.multFp.toString(), expected.multFp.toString(),
      `mult mismatch for winner car ${winner}`
    );
  });

  it("the winner claims exactly the mirrored payout", async () => {
    const r = await houseER.account.race.fetch(racePda);
    const rec = r.history[bettingSeq % 32];
    const winner = rec.winner;
    if (winner !== CAR_A && winner !== CAR_B) {
      // A car nobody backed won: mult must be 0 and the house took the pool.
      assert.equal(rec.multFp.toNumber(), 0);
      return;
    }
    const [kp, prog, bettor, ticket, stake] =
      winner === CAR_A
        ? [kpA, aER, bettorA, ticketA, STAKE_A]
        : [kpB, bER, bettorB, ticketB, STAKE_B];

    const pre = await prog.account.bettor.fetch(bettor);
    await sendIxHttp(
      erConn,
      prog.methods.claim()
        .accounts({ payer: kp.publicKey, mint, race: racePda, bettor, ticket }),
      kp
    );
    const post = await prog.account.bettor.fetch(bettor);
    const gained = BigInt(post.balance.toString()) - BigInt(pre.balance.toString());
    assert.equal(
      gained.toString(),
      payoutOf(stake, BigInt(rec.multFp.toString())).toString(),
      "claim did not match the mirror"
    );
  });

  it("commit_race lands state on L1 WITHOUT undelegating", async () => {
    const erRace = await houseER.account.race.fetch(racePda);
    await sendIxHttp(
      erConn,
      houseER.methods.commitRace().accounts({ payer: houseWallet.publicKey, race: racePda }),
      houseWallet.payer
    );

    let l1Seq = null;
    for (let i = 0; i < 40; i++) {
      const info = await baseConn.getAccountInfo(racePda);
      if (info) {
        // Race layout: 8-byte disc, 32-byte mint, then u64 seq.
        l1Seq = info.data.readBigUInt64LE(8 + 32);
        if (l1Seq >= BigInt(erRace.seq.toString())) break;
      }
      await sleep(2000);
    }
    assert.ok(l1Seq !== null && l1Seq >= BigInt(erRace.seq.toString()), "commit did not land");

    const info = await baseConn.getAccountInfo(racePda);
    assert.ok(
      info.owner.equals(DELEGATION_PROGRAM),
      "commit_race undelegated the Race — betting would stop"
    );
  });

  it("a bettor exits to L1 and withdraws real tokens", async () => {
    const pre = await getAccount(baseConn, ataA);
    await sendIxHttp(
      erConn,
      aER.methods.exitBettor()
        .accounts({ payer: kpA.publicKey, mint, bettor: bettorA, ticket: ticketA }),
      kpA
    );
    for (let i = 0; i < 40; i++) {
      const info = await baseConn.getAccountInfo(bettorA);
      if (info && info.owner.equals(pid)) break;
      await sleep(2000);
    }
    const owned = await baseConn.getAccountInfo(bettorA);
    assert.ok(owned.owner.equals(pid), "bettor never undelegated");

    const bal = await aBase.account.bettor.fetch(bettorA);
    await aBase.methods.withdraw(bal.balance)
      .accounts({ owner: kpA.publicKey, mint, bettor: bettorA, ownerToken: ataA,
                  vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    const post = await getAccount(baseConn, ataA);
    assert.ok(post.amount > pre.amount, "withdraw did not move tokens");
  });
});
```

- [ ] **Step 3: Deploy and run**

```bash
cd onchain/raider && anchor deploy -p paddock
```

```bash
cd onchain/raider && yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/paddock.ts
```

Expected: all five tests pass. A full cycle is ~61s and `before` spans two
delegation round-trips, so budget several minutes.

If the first test fails with a privilege or account-ownership error, the multi-payer
delegation assumption broke between the spike and the real program — diff the
`DelegateConfig` in `delegate_race` against `delegate_bettor` and confirm both name
the identical validator.

If it fails on `race rolled mid-bet`, raise the `waitForOpenMarket` runway argument
and rerun; that is a timing flake, not a defect.

- [ ] **Step 4: Remove the spike**

The spike's job was to de-risk Tasks 6–9; `tests/paddock.ts` now covers the same
ground against the real program.

```bash
git rm -r spikes/deleg-probe
git commit -m "paddock: e2e devnet driver; retire the delegation spike"
```

- [ ] **Step 5: Commit the driver**

```bash
git add onchain/raider/tests/paddock.ts onchain/raider/tests/paddock-helpers.ts
git commit -m "paddock: two-wallet shared-pool devnet e2e with exact payout mirror"
```

---

## Done criteria

- `cargo test -p paddock` green: state sizes, pari-mutuel conservation, draw permutation, seed binding.
- `tests/paddock.ts` green on devnet: two separately-delegated wallets betting concurrently into one pool with no lost update (spec risk 2), an unattended crank cycle, a payout matching the JS mirror exactly, and rake committed to L1 without undelegating (spec risk 4).
- `seed` verified all-zero during the betting window — the structural proof that the winner cannot be known while bets are open.
- No client file touched. `redline3d` builds and tests exactly as before.

## Follow-on plan (not this document)

Client rewiring — `bet-panel.ts` pools/wallet/`placeBet` onto the ER accounts,
`race-mode.ts` driven by on-chain `order[8]` and `phase_ends_ts`, deletion of the
fake-bettor inflow and the duplicated `mulberry32`. Write it against the generated
`target/idl/paddock.json` once this plan is green.
