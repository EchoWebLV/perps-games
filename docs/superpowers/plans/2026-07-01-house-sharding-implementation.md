# House Sharding (Single Pot + Per-Session Tills) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let many players run on-chain ER rounds concurrently against one shared bankroll, by carving a bet-sized "till" off a single master pot per session and sweeping it back when the session ends.

**Architecture:** The singleton `HouseBalance` PDA `[b"house", mint]` becomes the **master pot** (never delegated, lives on L1, funded once). Each session carves `slice = max_payout(selected_stake)` off the master into a per-player **till** PDA `[b"house", mint, owner]` (same layout), co-delegated with that player's Player+Round to the ER. The round settles against the till (settle math unchanged). At session end the till is swept back to the master on L1. Concurrency is bounded only by `master.balance ÷ slice`; when the pot can't cover a slice, the session is rejected ("tables full"). No `Round` field changes → no fresh-wallet migration. The pure pot↔till arithmetic is extracted into a unit-tested `house.rs` (mirrors how `settle.rs` isolates the settle math).

**Tech Stack:** Anchor 0.32.1 (`~/.avm/bin/anchor-0.32.1`), `ephemeral_rollups_sdk` 0.15.5, Solana devnet + MagicBlock ER, TypeScript client (`@coral-xyz/anchor`, web3.js, spl-token), Vitest (client unit + gated devnet integration), ts-mocha (Anchor suite), Claude Preview (browser verify).

**Spec:** `docs/superpowers/specs/2026-06-30-house-per-player-sharding-design.md`
**Branch:** `onchain-er-rebuild` (continue here — all prior on-chain work lives on it; not pushed).

**Key invariants (do not break):**
- 2000× leverage unchanged (`settle::RMAX = 2000`). Never touched.
- Settle money flow unchanged — only the `house` account it targets changes from the singleton to the per-session till.
- `max_payout(stake) = floor(stake × 23.75)` (`payout(stake, CAP_FP)`, CAP 25 × edge 0.95). At 0.01 SOL → 0.2375 SOL slice; at 0.10 SOL → 2.375 SOL slice.
- `BASE_PER_UNIT = 10_000_000` lamports (1 play unit = 0.01 SOL; stake is in lamports/base units).
- Conservation: `master.balance + Σ till.balance + Σ player.balance ≤ vault token balance` at all times. Master↔till and house↔player moves are u64 accounting transfers; real tokens never leave the vault except on `withdraw`.

---

## File Structure

**Program (`onchain/raider/programs/raider/src/`):**
- `house.rs` — **NEW.** Pure integer pot↔till arithmetic (`reclaim_and_slice`, `sweep`) + Rust unit tests. No Anchor types.
- `state.rs` — doc-only: note `HouseBalance` now serves the master pot AND per-session tills. Layout/`SIZE` unchanged.
- `lib.rs` — add `pub mod house;`; new `slice_from_pot` + `sweep_till` instructions and their `SliceFromPot`/`SweepTill` contexts; migrate the `house` account seed from `[house, mint]` to the till `[house, mint, owner]` in `OpenRound`, `CloseRound`, `ForceCloseRound`, `CrankClose`, `SessionCommit`, and `DelegateSession` (+ its `delegate_house` body call). `InitHouse`/`FundHouse`/`ScheduleTick` are NOT seed-migrated (master / forwarded-key respectively).

**Client (`redline3d/src/chain/`):**
- `chain-round.ts` — `deriveRaiderPdas` returns `master` + `till` (replacing `house`); add `sliceFromPot`/`sweepTill` + `maxPayoutBase` + `BankrollFullError`; all settle calls target `pdas.till`; `classifyDelegateState` keys on the till.
- `chain-round.test.ts` — update PDA-derivation + `classifyDelegateState` unit tests.
- `game-session.ts` — `ensureSession(buyInBase, stakeBase)` slices before delegate; `endSession()` sweeps after undelegate; surface bankroll-full.
- `game-session.test.ts` — update for the new `ensureSession` signature + slice/sweep calls.

**Game (`redline3d/src/`):**
- `main.ts` — read `playAmount` before `ensureSession`, pass the bet as the slice stake; map the `bankroll_full` error code to its message.

**Scripts (`redline3d/scripts/`):**
- `bootstrap-devnet.mjs` — already inits+funds `[house, mint]` (now the master pot). Comment-only clarification + bankroll default.
- `fund-wallet.mjs` — already SOL-only for wSOL. No functional change (verify).

**Tests:**
- `onchain/raider/tests/*.ts` — migrate the Anchor suite to slice-before-delegate + the till seed (shared `helpers.ts` gets a `deriveTill` + `sliceFromPot` helper).
- `redline3d/src/chain/chain-round.devnet.test.ts` — new gated concurrency + conservation test.

---

## Task 1: Pure pot↔till arithmetic (`house.rs`)

**Files:**
- Create: `onchain/raider/programs/raider/src/house.rs`
- Modify: `onchain/raider/programs/raider/src/lib.rs` (add `pub mod house;` near the other `pub mod` lines, ~line 20-22)

- [ ] **Step 1: Write the failing tests + module**

Create `onchain/raider/programs/raider/src/house.rs`:

```rust
// house.rs — pure pot↔till arithmetic for the single-pot / per-session-till house
// sharding model. Like settle.rs, this is pure integer math with NO Anchor types so
// the conservation invariants are unit-testable in isolation. The `slice_from_pot`
// and `sweep_till` instruction handlers in lib.rs are thin wrappers over these.
//
// Model: ONE master pot PDA `[b"house", mint]` (never delegated) holds the bankroll.
// Each active session carves a till PDA `[b"house", mint, owner]` off the master for
// the duration of its ER session, then sweeps it back. `master.balance + till.balance`
// is invariant across slice and sweep — value only ever moves between the pot and a
// till, never in or out.

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum HouseMathError {
    Overflow,
    Undercapitalized,
}

/// Session start: fold any leftover ALREADY in the till back into the master first
/// (self-healing — covers a skipped end-sweep or a delegate that failed after a prior
/// slice, so re-slicing never double-spends), then carve `slice` off the combined pot
/// into the till. Returns (new_master_balance, new_till_balance). Errors with
/// `Undercapitalized` when the combined pot can't cover the slice (the operator's
/// "bankroll under threshold → not playable" rule).
pub fn reclaim_and_slice(
    master_balance: u64,
    till_balance: u64,
    slice: u64,
) -> core::result::Result<(u64, u64), HouseMathError> {
    let pot = master_balance
        .checked_add(till_balance)
        .ok_or(HouseMathError::Overflow)?;
    if pot < slice {
        return Err(HouseMathError::Undercapitalized);
    }
    Ok((pot - slice, slice))
}

/// Session end: return the whole till balance to the master. Returns the new master
/// balance; the caller zeroes the till. Conserves master + till.
pub fn sweep(master_balance: u64, till_balance: u64) -> core::result::Result<u64, HouseMathError> {
    master_balance
        .checked_add(till_balance)
        .ok_or(HouseMathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_carves_off_master_and_conserves() {
        // master ~10 SOL of base units (10_000_000_000 lamports), no leftover,
        // slice a min-bet (0.01 SOL) worst case = 237_500_000.
        let (m, t) = reclaim_and_slice(10_000_000_000, 0, 237_500_000).unwrap();
        assert_eq!(m, 9_762_500_000);
        assert_eq!(t, 237_500_000);
        assert_eq!(m + t, 10_000_000_000); // conserved
    }

    #[test]
    fn slice_reclaims_leftover_before_carving() {
        // till still holds 300_000_000 from a skipped sweep; master 9_700_000_000.
        // combined 10_000_000_000; re-slice 237_500_000 → leftover folded back, not
        // double-spent: master 9_762_500_000, till 237_500_000.
        let (m, t) = reclaim_and_slice(9_700_000_000, 300_000_000, 237_500_000).unwrap();
        assert_eq!(m, 9_762_500_000);
        assert_eq!(t, 237_500_000);
        assert_eq!(m + t, 10_000_000_000);
    }

    #[test]
    fn slice_rejects_when_pot_cannot_cover() {
        // master + till = 200_000_000 < slice 237_500_000 → undercapitalized.
        assert_eq!(
            reclaim_and_slice(150_000_000, 50_000_000, 237_500_000),
            Err(HouseMathError::Undercapitalized)
        );
    }

    #[test]
    fn sweep_returns_whole_till_to_master() {
        // session ended with till = slice + house winnings (237.5M + 12.5M).
        assert_eq!(sweep(9_762_500_000, 250_000_000).unwrap(), 10_012_500_000);
    }

    #[test]
    fn sweep_after_player_win_returns_less() {
        // house lost 40M over the session: till = 197.5M. master back to 9_960_000_000.
        assert_eq!(sweep(9_762_500_000, 197_500_000).unwrap(), 9_960_000_000);
    }
}
```

Add to `lib.rs` alongside the existing module declarations (currently lines 20-22 `pub mod price; pub mod settle; pub mod state;`):

```rust
pub mod house;
pub mod price;
pub mod settle;
pub mod state;
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 test --skip-deploy --skip-local-validator 2>/dev/null; cargo test -p raider house:: --manifest-path programs/raider/Cargo.toml`

(Use `cargo test` directly for the pure unit tests — they need no validator.)

Run: `cd onchain/raider/programs/raider && cargo test house::`
Expected: PASS — 5 tests in `house::tests`.

- [ ] **Step 3: Commit**

```bash
git add onchain/raider/programs/raider/src/house.rs onchain/raider/programs/raider/src/lib.rs
git commit -m "feat(raider): pure pot<->till arithmetic (house.rs) for single-pot sharding"
```

---

## Task 2: `slice_from_pot` instruction + context

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs` (new handler in the `#[program]` mod near `fund_house` ~line 266; new context near `FundHouse` ~line 1000)

- [ ] **Step 1: Add the `use` for house math**

In `lib.rs`, after `use state::{...}` (lines 24-25), the `house` module is already declared (Task 1). Reference it as `house::` in the handler — no extra `use` needed.

- [ ] **Step 2: Add the `slice_from_pot` handler**

Insert into the `pub mod raider` module, after `fund_house` (after line 284):

```rust
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
```

- [ ] **Step 3: Add the `SliceFromPot` context**

Insert after the `FundHouse` context (after line 1030):

```rust
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
```

(`init_if_needed` is already enabled — `BuyIn` uses it for `player`.)

- [ ] **Step 4: Build to verify it compiles**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build`
Expected: builds clean (no errors). `target/idl/raider.json` now contains `slice_from_pot`.

- [ ] **Step 5: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs
git commit -m "feat(raider): slice_from_pot — carve a per-session till off the master pot"
```

---

## Task 3: `sweep_till` instruction + context

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs` (handler after `slice_from_pot`; context after `SliceFromPot`)

- [ ] **Step 1: Add the `sweep_till` handler**

Insert into the `pub mod raider` module, immediately after the `slice_from_pot` handler:

```rust
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
```

- [ ] **Step 2: Add the `SweepTill` context**

Insert after the `SliceFromPot` context:

```rust
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
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build`
Expected: builds clean. `target/idl/raider.json` now contains `sweep_till`.

- [ ] **Step 4: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs
git commit -m "feat(raider): sweep_till — permissionless return of a till to the master pot"
```

---

## Task 4: Migrate the `house` seed to the per-session till + state doc

The `house` account in the per-round / delegation contexts becomes the till `[HOUSE_SEED, mint, owner]`. `InitHouse` and `FundHouse` keep the master `[HOUSE_SEED, mint]`. `ScheduleTick.house` is an `UncheckedAccount` with no `seeds` constraint (just a forwarded key) — no Rust change there; the client passes the till key.

**Files:**
- Modify: `onchain/raider/programs/raider/src/state.rs` (doc comment ~lines 51-58)
- Modify: `onchain/raider/programs/raider/src/lib.rs` (`delegate_session` body + 5 contexts)

- [ ] **Step 1: state.rs doc-only update**

In `state.rs`, replace the `HouseBalance` doc context. Change the struct doc above `pub struct HouseBalance` (or add a line) to note the dual role. Find the `#[account] pub struct HouseBalance {` (line 51-52) and prepend a doc comment:

```rust
/// HouseBalance backs BOTH roles in the sharding model: the singleton master pot
/// `[b"house", mint]` (the bankroll; never delegated) AND each per-session till
/// `[b"house", mint, owner]` (carved off the master, co-delegated with Player+Round
/// for one ER session, swept back at end). Identical layout/SIZE for both.
#[account]
pub struct HouseBalance {
```

- [ ] **Step 2: Migrate `delegate_session` body**

In `lib.rs`, in the `delegate_session` handler, the `delegate_house` call (lines 237-244) currently passes `&[HOUSE_SEED, mint.as_ref()]`. Change it to include the owner:

```rust
        ctx.accounts.delegate_house(
            &ctx.accounts.payer,
            &[HOUSE_SEED, mint.as_ref(), owner.as_ref()],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
```

(`owner` is already bound at the top of the handler: `let owner = ctx.accounts.payer.key();`)

- [ ] **Step 3: Migrate the `DelegateSession` context house seed**

In `lib.rs`, the `DelegateSession` context (line 993) — change the `house` account seeds:

```rust
    /// CHECK: per-session HouseBalance till PDA to delegate
    #[account(mut, del, seeds = [HOUSE_SEED, mint.key().as_ref(), payer.key().as_ref()], bump)]
    pub house: AccountInfo<'info>,
```

- [ ] **Step 4: Migrate the four typed-context house seeds**

In `lib.rs`, in EACH of `OpenRound` (line 1044), `CloseRound` (line 1074), `ForceCloseRound` (line 1115), and `CrankClose` (line 1148), the `house` block currently reads:

```rust
    #[account(
        mut,
        seeds = [HOUSE_SEED, mint.key().as_ref()],
        bump = house.bump,
    )]
    pub house: Account<'info, HouseBalance>,
```

Change it (in all four contexts) to the till seed:

```rust
    #[account(
        mut,
        seeds = [HOUSE_SEED, mint.key().as_ref(), player.owner.as_ref()],
        bump = house.bump,
    )]
    pub house: Account<'info, HouseBalance>,
```

(In all four, `player` is declared before `house`, so `player.owner` is in scope for the seed — same way `round`'s seed already references `player.owner`.)

- [ ] **Step 5: Migrate the `SessionCommit` context house seed**

In `lib.rs`, `SessionCommit` (line 1206) currently:

```rust
    #[account(mut, seeds = [HOUSE_SEED, mint.key().as_ref()], bump = house.bump)]
    pub house: Account<'info, HouseBalance>,
```

Change to:

```rust
    #[account(mut, seeds = [HOUSE_SEED, mint.key().as_ref(), player.owner.as_ref()], bump = house.bump)]
    pub house: Account<'info, HouseBalance>,
```

(`player` is declared before `house` in `SessionCommit`.)

- [ ] **Step 6: Confirm `ScheduleTick` is NOT changed**

`ScheduleTick.house` (line 1181-1182) is `#[account(mut)] pub house: UncheckedAccount<'info>` with NO `seeds` constraint — it forwards whatever key the client passes into the scheduled `tick_crank` metas. The client will pass the till key (Task 6). Leave this context unchanged. (The scheduled `tick_crank` runs through `CrankClose`, whose house seed IS migrated in Step 4, so the forwarded key must be the till PDA — which it will be.)

- [ ] **Step 7: Build to verify it compiles**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build`
Expected: builds clean.

- [ ] **Step 8: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs onchain/raider/programs/raider/src/state.rs
git commit -m "feat(raider): migrate house account to per-session till [house,mint,owner]"
```

---

## Task 5: Redeploy to devnet + regenerate the client IDL

The master pot `[house, mint]` keeps the SAME address as today's house (seed unchanged), so the existing devnet bankroll carries over in-place — no fresh house wallet needed (this is exactly the per-mint-singleton wedge being fixed).

**Files:**
- Modify: `redline3d/src/chain/idl/raider.json`, `redline3d/src/chain/idl/raider.ts` (regenerated copies)

- [ ] **Step 1: Deploy the upgraded program**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 deploy --provider.cluster devnet`
Expected: `Program Id: FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv`, "Deploy success". (Upgrade in place; the program keypair authority is the bootstrap wallet `~/.config/solana/lazer-probe.json`.)

- [ ] **Step 2: Copy the regenerated IDL into the client**

Run:
```bash
cd /Users/yordanlasonov/Documents/GitHub/perps-games
cp onchain/raider/target/idl/raider.json redline3d/src/chain/idl/raider.json
cp onchain/raider/target/types/raider.ts redline3d/src/chain/idl/raider.ts
```
Expected: both files updated; `grep -c slice_from_pot redline3d/src/chain/idl/raider.json` returns ≥ 1, same for `sweep_till`.

- [ ] **Step 3: Ensure the master pot is funded & undelegated**

Run: `cd redline3d && ANCHOR_WALLET=~/.config/solana/lazer-probe.json HOUSE_FUND=10000000000 npm run chain:bootstrap`
Expected: prints `house funded: balance=<≥10000000000>` and the registry verify lines. (`HOUSE_FUND=10000000000` = 10 SOL of wSOL base units; idempotent — re-funds the existing master.) If the master shows as delegated (owner = DELeGG…), an abandoned prior session is holding it — run a `commit_and_undelegate` against it first (note for the operator; the master is never delegated under the new code, so this only applies to pre-upgrade state).

- [ ] **Step 4: Verify IDL types compile in the client**

Run: `cd redline3d && npx tsc --noEmit`
Expected: no NEW errors from the IDL (there will be client errors until Task 6 wires the new methods — that's fine; confirm the IDL itself parses by checking `raider.ts` has `sliceFromPot` and `sweepTill` in the instructions union).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/chain/idl/raider.json redline3d/src/chain/idl/raider.ts
git commit -m "chore(client): regenerate raider IDL (slice_from_pot, sweep_till, till seeds)"
```

---

## Task 6: Client `chain-round.ts` — master/till PDAs, slice/sweep, settle → till

**Files:**
- Modify: `redline3d/src/chain/chain-round.ts`
- Test: `redline3d/src/chain/chain-round.test.ts`

- [ ] **Step 1: Write the failing unit tests**

In `chain-round.test.ts`, replace the first `it("derives the same PDAs...")` test (lines 8-19) and the `classifyDelegateState` describe block (lines 56-82) with versions keyed on master/till. Replace lines 8-19 with:

```ts
  it("derives master, till, and the per-player PDAs the program expects", () => {
    const owner = new PublicKey("FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM");
    const mint = new PublicKey("3TDF3grFqPJEdX4BhoCYzZuiRG6wrhKYE89wxoEg5kMX");
    const program = new PublicKey("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");
    const pdas = deriveRaiderPdas(program, owner, mint);
    const [player] = PublicKey.findProgramAddressSync([Buffer.from("player"), owner.toBuffer(), mint.toBuffer()], program);
    const [master] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program);
    const [till] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer(), owner.toBuffer()], program);
    const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), owner.toBuffer()], program);
    expect(pdas.player.equals(player)).toBe(true);
    expect(pdas.master.equals(master)).toBe(true);
    expect(pdas.till.equals(till)).toBe(true);
    expect(pdas.round.equals(round)).toBe(true);
    expect(pdas.master.equals(pdas.till)).toBe(false); // master and till are distinct accounts
  });
```

Add a `maxPayoutBase` import to the top (line 3) — change to:
```ts
import { deriveRaiderPdas, rawToHuman, roundToSnap, actionResultFromSnap, maxPayoutBase } from "./chain-round";
```
and add a test after the PDA test:
```ts
  it("maxPayoutBase mirrors settle::max_payout (stake × 23.75)", () => {
    expect(maxPayoutBase(10_000_000)).toBe(237_500_000);   // 0.01 SOL → 0.2375 SOL
    expect(maxPayoutBase(100_000_000)).toBe(2_375_000_000); // 0.10 SOL → 2.375 SOL
  });
```

Replace the `classifyDelegateState` describe block (lines 56-82) to key on `till` instead of `house`:
```ts
describe("classifyDelegateState", () => {
  const DEL = CHAIN.DELEGATION_PROGRAM;
  const PROG = CHAIN.PROGRAM_ID;

  it("reuse when all three delegated accounts are already delegated (our own live session)", () => {
    expect(classifyDelegateState({ player: DEL, till: DEL, round: DEL })).toBe("reuse");
  });

  it("fresh when none are delegated (nulls allowed for not-yet-created PDAs)", () => {
    expect(classifyDelegateState({ player: null, till: PROG, round: null })).toBe("fresh");
    expect(classifyDelegateState({ player: PROG, till: PROG, round: PROG })).toBe("fresh");
  });

  it("busy only on a torn mid-delegation (the per-session till can't be foreign-held)", () => {
    expect(classifyDelegateState({ player: DEL, till: DEL, round: PROG })).toBe("busy");
  });

  it("DelegateBusyError carries a typed code", () => {
    const e = new DelegateBusyError("nope");
    expect(e.code).toBe("delegate_busy");
    expect(e.message).toBe("nope");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd redline3d && npx vitest run src/chain/chain-round.test.ts`
Expected: FAIL — `pdas.master`/`pdas.till`/`maxPayoutBase` undefined, `classifyDelegateState` param `till` mismatch.

- [ ] **Step 3: Update `chain-round.ts` — interface, derive, maxPayoutBase, BankrollFullError**

In `chain-round.ts`:

(a) Replace the `RaiderPdas` interface (line 13):
```ts
export interface RaiderPdas { player: PublicKey; master: PublicKey; till: PublicKey; round: PublicKey; vaultAuthority: PublicKey; vaultToken: PublicKey; }
```

(b) Replace `deriveRaiderPdas` (lines 15-23):
```ts
/** Derive the raider PDAs + the vault ATA for an owner+mint (matches lib.rs seeds).
 *  `master` = singleton bankroll `[house, mint]`; `till` = per-session `[house, mint, owner]`. */
export function deriveRaiderPdas(programId: PublicKey, owner: PublicKey, mint: PublicKey): RaiderPdas {
  const [player] = PublicKey.findProgramAddressSync([Buffer.from("player"), owner.toBuffer(), mint.toBuffer()], programId);
  const [master] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], programId);
  const [till] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer(), owner.toBuffer()], programId);
  const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), owner.toBuffer()], programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], programId);
  const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
  return { player, master, till, round, vaultAuthority, vaultToken };
}

/** Mirror settle::max_payout — floor(stake × 23.75) (CAP_FP 25e6 × edge 0.95). The
 *  per-session slice carved off the master pot equals this for the player's bet. */
export function maxPayoutBase(stake: number): number {
  return Number((BigInt(stake) * 25_000_000n * 950_000n) / 1_000_000n / 1_000_000n);
}
```

(c) Add a typed bankroll-full error next to `DelegateBusyError` (after line 40):
```ts
/** Session start rejected: the master pot can't cover this bet's slice (bankroll fully in play). */
export class BankrollFullError extends Error {
  readonly code = "bankroll_full" as const;
  constructor(message: string) { super(message); this.name = "BankrollFullError"; }
}
```

(d) Update `classifyDelegateState` (lines 50-58) to key on `till`:
```ts
export function classifyDelegateState(owners: {
  player: PublicKey | null; till: PublicKey | null; round: PublicKey | null;
}): DelegateState {
  const del = (o: PublicKey | null) => !!o && o.equals(CHAIN.DELEGATION_PROGRAM);
  const p = del(owners.player), t = del(owners.till), r = del(owners.round);
  if (p && t && r) return "reuse";
  if (!p && !t && !r) return "fresh";
  return "busy";
}
```
And update the doc comment above it (lines 44-49): the three delegated accounts are now player/till/round; "busy" = torn mid-delegation only (a per-session till can never be foreign-held).

- [ ] **Step 4: Update `chain-round.ts` — add slice/sweep methods + retarget settle calls to the till**

(a) Add `sliceFromPot` / `sweepTill` to the `ChainRound` interface (after `delegate()`, line 105):
```ts
  sliceFromPot(slice: number): Promise<void>;
  sweepTill(): Promise<void>;
```

(b) In `createChainRound`, the `delegate()` method (lines 196-219): replace the three account reads + classify call so it reads the TILL (not master):
```ts
    async delegate() {
      const [pi, ti, ri] = await Promise.all([
        baseConn.getAccountInfo(pdas.player),
        baseConn.getAccountInfo(pdas.till),
        baseConn.getAccountInfo(pdas.round),
      ]);
      const state = classifyDelegateState({ player: pi?.owner ?? null, till: ti?.owner ?? null, round: ri?.owner ?? null });
      if (state === "reuse") return;
      if (state === "busy") {
        throw new DelegateBusyError("Session busy — end your previous session and try again.");
      }
      try {
        await send(baseConn, program.methods.delegateSession().accountsPartial({
          payer: owner, mint, player: pdas.player, house: pdas.till, round: pdas.round,
        }).remainingAccounts([{ pubkey: CHAIN.VALIDATOR, isSigner: false, isWritable: false }]), 400_000);
      } catch (e) {
        if (String((e as Error).message).includes("ExternalAccountDataModified")) {
          throw new DelegateBusyError("Session busy — try again in a moment.");
        }
        throw e;
      }
      await pollOwner(CHAIN.DELEGATION_PROGRAM, "delegate", 25, 1000);
    },
```

(c) Update `pollOwner` (lines 160-167) to poll the till instead of the master house:
```ts
  async function pollOwner(target: PublicKey, label: string, tries: number, gapMs: number) {
    for (let i = 0; i < tries; i++) {
      const infos = await Promise.all([pdas.player, pdas.till, pdas.round].map((p) => baseConn.getAccountInfo(p)));
      if (infos.every((info) => info && info.owner.equals(target))) return;
      await sleep(gapMs);
    }
    throw new Error(`${label}: PDAs did not reach owner ${target.toBase58()} in time`);
  }
```

(d) Add the two new methods (place after `delegate()` in the returned object):
```ts
    async sliceFromPot(slice) {
      // Pre-check the pot so the common "bankroll fully in play" case fails fast with a
      // typed error instead of a raw tx failure (a race where the last slice is taken
      // between this read and the send is caught below as a fallback).
      const master = await program.account.houseBalance.fetchNullable(pdas.master);
      if (!master || BigInt(master.balance.toString()) < BigInt(slice)) {
        throw new BankrollFullError("Tables are full right now — the bankroll is fully in play. Try again in a moment.");
      }
      try {
        await send(baseConn, program.methods.sliceFromPot(new BN(slice)).accountsPartial({
          owner, mint, master: pdas.master, till: pdas.till, systemProgram: SystemProgram.programId,
        }));
      } catch (e) {
        if (String((e as Error).message).includes("HouseUndercapitalized") || String((e as Error).message).includes("0x6")) {
          throw new BankrollFullError("Tables are full right now — the bankroll is fully in play. Try again in a moment.");
        }
        throw e;
      }
    },

    async sweepTill() {
      await send(baseConn, program.methods.sweepTill().accountsPartial({
        payer: owner, mint, owner, master: pdas.master, till: pdas.till,
      }));
    },
```
(The `0x6`-prefix check is a coarse fallback for the custom-error range; the client-side pre-check is the primary path. Keep both.)

(e) Retarget EVERY remaining settle call from `house: pdas.house` to `house: pdas.till`. These are in: `open` (line 223), `close` (line 230-231), `forceClose` (line 239-240), `flip` (line 254-255), `lever` (line 263-264), `scheduleCrank` (line 275-276), `commitAndUndelegate` (line 281-282). In each `accountsPartial({...})`, change `house: pdas.house` → `house: pdas.till`. (`scheduleCrank` forwards the till key into the crank metas; the scheduled `tick_crank` re-derives the till by seed — matches.)

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `cd redline3d && npx vitest run src/chain/chain-round.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd redline3d && npx tsc --noEmit`
Expected: no errors in `chain-round.ts` (game-session.ts errors about `ensureSession` are addressed in Task 7).

- [ ] **Step 7: Commit**

```bash
git add redline3d/src/chain/chain-round.ts redline3d/src/chain/chain-round.test.ts
git commit -m "feat(client): chain-round master/till PDAs + slice_from_pot/sweep_till"
```

---

## Task 7: `game-session.ts` — slice before delegate, sweep after undelegate

**Files:**
- Modify: `redline3d/src/chain/game-session.ts`
- Test: `redline3d/src/chain/game-session.test.ts`

- [ ] **Step 1: Update the fake harness + existing calls, then write the failing test**

The existing `game-session.test.ts` uses a `fakeChain(over: Partial<ChainRound> = {})` factory (vi.fn mocks spread over `...over`) and every existing test calls `s.ensureSession(2_000_000)` with ONE arg. Three edits:

(a) Add the two new methods to the `fakeChain` factory defaults (after `delegate:` line 17, and alongside the others) so the object still satisfies `ChainRound`:
```ts
    sliceFromPot: vi.fn(async () => {}),
    sweepTill: vi.fn(async () => {}),
```

(b) Add the import and update EVERY existing `s.ensureSession(2_000_000)` call (lines 45, 56, 57, 66, 93, 115) to pass a stake as the 2nd arg: `s.ensureSession(2_000_000, 1_000_000)`. Add to the imports at the top:
```ts
import { maxPayoutBase } from "./chain-round";
```

(c) Add the new test (uses vitest mock `invocationCallOrder` for ordering):
```ts
  it("slices the bet's worst-case payout off the pot before delegating, sweeps after undelegate", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(50_000_000, 10_000_000); // buy-in 0.05 SOL, bet 0.01 SOL
    expect(chain.sliceFromPot).toHaveBeenCalledWith(maxPayoutBase(10_000_000)); // 237_500_000
    expect((chain.sliceFromPot as any).mock.invocationCallOrder[0])
      .toBeLessThan((chain.delegate as any).mock.invocationCallOrder[0]);
    await s.endSession();
    expect((chain.commitAndUndelegate as any).mock.invocationCallOrder[0])
      .toBeLessThan((chain.sweepTill as any).mock.invocationCallOrder[0]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd redline3d && npx vitest run src/chain/game-session.test.ts`
Expected: FAIL — `ensureSession` takes one arg / `sliceFromPot` not called.

- [ ] **Step 3: Update `game-session.ts`**

(a) Import `maxPayoutBase` (line 5):
```ts
import { createChainRound, maxPayoutBase, type ChainRound, type OpenedRound, type SettledRound, type ActionResult, type RoundSnap, type AssetSym } from "./chain-round";
```

(b) Change the `ensureSession` signature in the `GameSession` interface (line 18):
```ts
  ensureSession(buyInBase: number, stakeBase: number): Promise<void>;
```

(c) Replace the `ensureSession` implementation (lines 79-88):
```ts
    async ensureSession(buyInBase, stakeBase) {
      const c = need();
      if (isDelegated) return;
      const onL1 = await c.readPlayerBalance(false);
      if (onL1 === 0n) { await c.wrapForBuyIn(buyInBase); await c.buyIn(buyInBase); }
      await c.ensureRoundInited();
      // Carve a bet-sized till off the master pot BEFORE delegating it (throws
      // BankrollFullError if the pot can't cover the slice).
      await c.sliceFromPot(maxPayoutBase(stakeBase));
      await c.delegate(); // hardened: reuses a stale-but-live same-wallet session, else throws DelegateBusyError
      isDelegated = true;
      bal = await c.readPlayerBalance(true);
    },
```

(d) Replace the `endSession` implementation (lines 116-120):
```ts
    async endSession() {
      const c = need();
      await c.commitAndUndelegate();
      // Return the till's leftover to the master pot so losses fund the next player
      // (self-smoothing). Tolerate a rare locked till (abandoned open round) — the
      // undelegate already landed; reclaim happens on the next slice or via a keeper.
      try { await c.sweepTill(); } catch (e) { console.warn("sweep_till skipped:", e); }
      isDelegated = false;
      bal = await c.readPlayerBalance(false);
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd redline3d && npx vitest run src/chain/game-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/chain/game-session.ts redline3d/src/chain/game-session.test.ts
git commit -m "feat(client): game-session slices before delegate, sweeps after undelegate"
```

---

## Task 8: `main.ts` — thread the bet into the slice + surface bankroll-full

**Files:**
- Modify: `redline3d/src/main.ts` (the `controls.onLaunch` GO handler, lines 379-395)

- [ ] **Step 1: Read the current playAmount BEFORE ensureSession and pass it as the slice stake**

In the GO handler, the bet (`controls.playAmount()`) is currently read at line 390, AFTER `ensureSession`. The slice must be sized to the bet, so read it first. Replace lines 380-395:

```ts
    // First GO auto-starts the ER session (buy-in if empty + slice the bankroll + delegate).
    const playAmount = controls.playAmount(); // 0.01-SOL units — sizes the bankroll slice
    hud.setStatus("Starting session…");
    try {
      await session.ensureSession(BUY_IN_BASE, unitsToBase(playAmount));
    } catch (e: any) {
      const friendly = e?.code === "delegate_busy" || e?.code === "bankroll_full";
      hud.setStatus(friendly ? e.message : "Couldn't start the session. Try again.");
      return;
    }
    await session.refreshBalance(true); syncOnchainBalance();

    if (session.balance() < BigInt(unitsToBase(playAmount))) {
      hud.setStatus("Add SOL to your play balance to race.");
      walletUI.open();
      return;
    }
```

(The later `const dir = controls.dir();` / `lev` / `session.open(asset, dir, lev, unitsToBase(playAmount))` block at lines 396-401 stays as-is — `playAmount` is now in scope from above. Remove the now-duplicate `const playAmount = controls.playAmount();` that was at line 390.)

- [ ] **Step 2: Surface the rare "till drained mid-session" case on `open`**

The spec's error-handling list includes: if a hot streak drains the till below a round's `max_payout`, `open` rejects with `HouseUndercapitalized` mid-session → tell the player to end & restart (which re-slices from the pot). Update the existing `open` catch (currently lines 402-407: `console.error(...); hud.setStatus("Couldn't start the round. Try again."); ...`):

```ts
    } catch (e: any) {
      console.error("on-chain open failed", e);
      const drained = String(e?.message ?? "").includes("HouseUndercapitalized");
      hud.setStatus(drained
        ? "This session's bankroll is spent — End your session, then press GO to start fresh."
        : "Couldn't start the round. Try again.");
      controls.setLive(false, "GO!");
      return;
    }
```

- [ ] **Step 3: Typecheck + unit suite**

Run: `cd redline3d && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all client unit tests pass (the `selectChainWalletPort` / main-entrypoint test still passes — no heavy-SDK import added).

- [ ] **Step 4: Commit**

```bash
git add redline3d/src/main.ts
git commit -m "feat(game): size the bankroll slice to the bet; surface bankroll-full + drained-till on GO"
```

---

## Task 9: Bootstrap/fund scripts (verify + clarify)

The scripts already do the right thing — `bootstrap-devnet.mjs` inits+funds `[house, mint]` (now the master pot) and `fund-wallet.mjs` funds native SOL only for wSOL. This task only confirms and clarifies.

**Files:**
- Modify: `redline3d/scripts/bootstrap-devnet.mjs` (comments + default)

- [ ] **Step 1: Clarify the master-pot role + bump the default bankroll**

In `bootstrap-devnet.mjs`, update the header comment (lines 1-4) and the `HOUSE_FUND` default (line 12) to reflect the single-pot model:

```js
// Operator one-time devnet bootstrap: create/reuse a stake mint, init the MASTER POT
// (HouseBalance `[house, mint]` — the single shared bankroll; per-session tills are
// carved off it automatically by slice_from_pot), fund it, and set up the feed registry.
//   ANCHOR_WALLET=~/.config/solana/lazer-probe.json HOUSE_FUND=10000000000 node scripts/bootstrap-devnet.mjs
```
```js
const HOUSE_FUND = Number(process.env.HOUSE_FUND || 10_000_000_000); // 10 SOL master-pot bankroll (wSOL base units)
```

- [ ] **Step 2: Confirm fund-wallet.mjs needs no change**

Read `fund-wallet.mjs`. Confirm it transfers native SOL (default 0.4) and only mints test-USDC for non-wSOL mints — which is correct (players wrap in-game; the master pot auto-slices, so no per-player house funding is needed). No edit. Note this in the commit body.

- [ ] **Step 3: Commit**

```bash
git add redline3d/scripts/bootstrap-devnet.mjs
git commit -m "chore(scripts): bootstrap clarifies master-pot role; 10 SOL default bankroll"
```

---

## Task 10: Migrate the Anchor TS test suite to slice-before-delegate + till seed

The seed change breaks every ER-loop test that derives `[house, mint]` and passes it to `delegate_session`/`open`/`close`/etc. Migrate them: derive the till `[house, mint, owner]`, call `slice_from_pot` after `init_round` and before `delegate_session`, and pass the till as the `house` account everywhere downstream. The master `[house, mint]` is still funded by the operator-setup block in each test.

**Files:**
- Modify: `onchain/raider/tests/helpers.ts` (add `deriveTill` + `sliceFromPot` helper)
- Modify: ER-loop tests: `raider.ts`, `delegate.ts`, `open.ts`, `close.ts`, `flip.ts`, `lever.ts`, `liq.ts`, `forceclose.ts`, `timecap.ts`, `tick-liq.ts`, `tick-liq-crank.ts`, `latency.ts`, `latency-tick.ts`, `raceguard.ts`, `keeper.ts`, `gates.ts`, `feedauth.ts`
- (L1-only tests `init.ts`, `deposit.ts` need no till — verify.)

- [ ] **Step 1: Add helpers to `helpers.ts`**

Append to `helpers.ts` (before `module.exports`) and export them:

```js
// Per-session till PDA `[b"house", mint, owner]` (the master pot is `[b"house", mint]`).
function deriveTill(programId, mint, owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("house"), mint.toBuffer(), owner.toBuffer()],
    programId
  )[0];
}

// Mirror settle::max_payout — floor(stake * 23.75) — the bet-sized slice carved off the pot.
function maxPayout(stake) {
  return Number((BigInt(stake) * 25_000_000n * 950_000n) / 1_000_000n / 1_000_000n);
}
```

Add `deriveTill` and `maxPayout` to `module.exports`.

- [ ] **Step 2: Define the per-file transform (apply to each ER-loop test)**

For EACH ER-loop test file, apply this exact transform:

1. Where it derives the house — `const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], programId)` — KEEP it (it's the master, still funded by `fund_house`). Add right after it:
   ```js
   const till = deriveTill(programId, mint, player.publicKey); // per-session till (was the shared house)
   ```
   (Use the test's actual program-id variable — usually `program.programId` — and its player keypair var.)

2. After `init_round` and BEFORE `delegate_session`, insert a slice call sized to the test's stake (the stake the test passes to `open`, e.g. `1_000_000`):
   ```js
   await program.methods.sliceFromPot(new anchor.BN(maxPayout(STAKE))).accounts({
     owner: player.publicKey, mint, master: house, till, systemProgram: SystemProgram.programId,
   }).rpc({ skipPreflight: true }); // or via the test's signer/send helper, signed by `player`
   ```
   where `STAKE` is the test's stake constant. (Tests that buy in 5_000_000 and open 1_000_000 should slice `maxPayout(1_000_000)` = 23_750_000.)

3. In `delegate_session` accounts, change `house` → `till`: `{ payer: player.publicKey, mint, player: <playerPda>, house: till, round: <roundPda> }`.

4. In EVERY `open` / `close` / `flip` / `lever` / `forceClose` / `tick` / `scheduleTick` / `commitAndUndelegate` / `tickCrank` `.accounts({...})`, change `house: <housePda>` → `house: till`.

5. For the native crank path (`tick-liq-crank.ts`, `latency-tick.ts`): the `scheduleTick` accounts pass `house: till`; the scheduled `tick_crank` re-derives the till by seed → matches automatically. No extra change.

6. After `commit_and_undelegate` (where the test asserts settled state on L1), OPTIONALLY add a `sweep_till` + master-conservation assertion (covered more thoroughly in the devnet integration test, Task 9-of-client below; for the Anchor suite a single representative test — `raider.ts` — should add it):
   ```js
   const masterBefore = (await program.account.houseBalance.fetch(house)).balance;
   await program.methods.sweepTill().accounts({
     payer: player.publicKey, mint, owner: player.publicKey, master: house, till,
   }).rpc({ skipPreflight: true });
   const tillAfter = (await program.account.houseBalance.fetch(till)).balance;
   const masterAfter = (await program.account.houseBalance.fetch(house)).balance;
   expect(tillAfter.toNumber()).to.equal(0);
   // master regained the till's leftover (slice ± this session's P&L)
   expect(masterAfter.toNumber()).to.be.greaterThan(masterBefore.toNumber());
   ```

- [ ] **Step 3: Apply the transform to `raider.ts` (the headline 6/6 suite) first**

`raider.ts` is the canonical full-loop test (buy_in→delegate→open→close→undelegate→withdraw + conservation + provable-fairness recompute). Apply Step 2 to it including the Step 2.6 sweep+conservation assertion.

- [ ] **Step 4: Run the headline test**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 test --skip-deploy --skip-build tests/raider.ts` (program already deployed in Task 5).
Expected: PASS (6/6 or the file's count), including the new sweep/conservation assertion.

- [ ] **Step 5: Apply the transform to the remaining ER-loop test files**

Apply Step 2 (without the optional 2.6 assertion) to: `delegate.ts`, `open.ts`, `close.ts`, `flip.ts`, `lever.ts`, `liq.ts`, `forceclose.ts`, `timecap.ts`, `tick-liq.ts`, `tick-liq-crank.ts`, `latency.ts`, `latency-tick.ts`, `raceguard.ts`, `keeper.ts`, `gates.ts`, `feedauth.ts`. Verify `init.ts`/`deposit.ts` are L1-only (no delegate/open) and need no change.

- [ ] **Step 6: Run the full Anchor suite**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 test --skip-deploy --skip-build`
Expected: all tests PASS (suite green against the till seed). Re-run any flaky devnet-timing failures once.

- [ ] **Step 7: Commit**

```bash
git add onchain/raider/tests
git commit -m "test(raider): migrate Anchor suite to slice-before-delegate + per-session till"
```

---

## Task 11: Gated devnet concurrency + conservation integration test

**Files:**
- Modify: `redline3d/src/chain/chain-round.devnet.test.ts` (add a new `it(...)` in the existing `describe.skipIf(!RUN)` block)

- [ ] **Step 1: Write the concurrency test**

Add this test to `chain-round.devnet.test.ts` (gated on `RAIDER_DEVNET=1`). It uses a FRESH mint + master pot funded to cover exactly two min-bet slices but not three, proving (a) two wallets delegate concurrently with no `delegate_busy`, (b) conservation across the pot after both sweep, (c) a third session is rejected when the pot can't cover another slice.

```ts
  it("two wallets run concurrent sessions off one pot; conservation holds; a third is rejected", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);

    // operator: fresh mint + master pot funded to cover ~2 min-bet slices, NOT 3.
    // stake 1_000_000 → maxPayout = 23_750_000; fund 50_000_000 (covers 2, not 3).
    const STAKE = 1_000_000;
    const SLICE = Number((BigInt(STAKE) * 25_000_000n * 950_000n) / 1_000_000n / 1_000_000n); // 23_750_000
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const [master] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse().accounts({ authority: funder.publicKey, mint, house: master, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 50_000_000);
    await program.methods.fundHouse(new anchor.BN(50_000_000)).accounts({ funder: funder.publicKey, mint, house: master, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });
    const masterStart = Number((await program.account.houseBalance.fetch(master)).balance);

    // helper: fund a fresh dev-keypair player + build its chain client
    const makePlayer = async () => {
      const kp = Keypair.generate();
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
      const ata = await getOrCreateAssociatedTokenAccount(conn, funder, mint, kp.publicKey);
      await mintTo(conn, funder, mint, ata.address, funder.publicKey, 5_000_000);
      const port = createDevKeypairPort({ secretKey: kp.secretKey, store: { get: () => null, set: () => {} } });
      await port.connect();
      return { kp, chain: createChainRound({ wallet: portToAnchorWallet(port), mint }) };
    };

    const a = await makePlayer();
    const b = await makePlayer();

    // both buy in + init round + slice + delegate — CONCURRENTLY (neither gets delegate_busy)
    const startSession = async (p: typeof a) => {
      await p.chain.buyIn(5_000_000);
      await p.chain.ensureRoundInited();
      await p.chain.sliceFromPot(SLICE);
      await p.chain.delegate();
    };
    await Promise.all([startSession(a), startSession(b)]); // <-- the headline: concurrent delegate, no busy error

    // pot now down by 2 slices → a THIRD slice must be rejected (bankroll fully in play)
    const c = await makePlayer();
    await c.chain.buyIn(5_000_000);
    await c.chain.ensureRoundInited();
    await expect(c.chain.sliceFromPot(SLICE)).rejects.toMatchObject({ code: "bankroll_full" });

    // each plays a round and settles
    const playAndSettle = async (p: typeof a) => {
      await p.chain.open("BTC", 1, 100, STAKE);
      await sleep(6000);
      const settled = await p.chain.close();
      expect(["cashout", "cap", "liq", "time"]).toContain(settled.outcomeName);
      await p.chain.commitAndUndelegate();
      await p.chain.sweepTill();
    };
    await Promise.all([playAndSettle(a), playAndSettle(b)]);

    // conservation across the pot: master net change == -(sum of player net P&L) (edge stays house-side).
    // Each player's net = (final L1 balance) - 5_000_000 buy-in. House gained the negatives of those.
    const aNet = Number(await a.chain.readPlayerBalance(false)) - 5_000_000;
    const bNet = Number(await b.chain.readPlayerBalance(false)) - 5_000_000;
    const masterEnd = Number((await program.account.houseBalance.fetch(master)).balance);
    expect(masterEnd - masterStart).to.equal(-(aNet + bNet)); // pot absorbed losses / paid winnings, conserved
  }, 240_000);
```

(Note: import `expect` chaining style matches the file's `vitest` `expect`; the `.to.equal` calls in the Anchor `chai` example above are for Task 10 — in this Vitest file use `expect(x).toBe(y)`. Adjust the two conservation asserts to `expect(masterEnd - masterStart).toBe(-(aNet + bNet))`.)

- [ ] **Step 2: Run the gated integration suite**

Run: `cd redline3d && RAIDER_DEVNET=1 npm run chain:itest`
Expected: the existing single-player loop test PASSES (no-regression against the till path) AND the new concurrency test PASSES (concurrent delegate with no busy, third rejected with `bankroll_full`, conservation holds).

- [ ] **Step 3: Commit**

```bash
git add redline3d/src/chain/chain-round.devnet.test.ts
git commit -m "test(client): gated devnet concurrency + pot-conservation integration test"
```

---

## Task 12: Browser verification (Claude Preview) + memory update

Per [[verify-ui-in-browser-before-done]]: tsc/tests green ≠ it works. Prove the real game still plays end-to-end with the slice/sweep invisible underneath.

**Files:** none (verification + memory)

- [ ] **Step 1: Start the on-chain dev server**

Run: `cd redline3d && npm run dev` (dev-keypair wallet). Use the `preview_*` tools against the served URL (e.g. `http://localhost:5173` or the configured port).

- [ ] **Step 2: Fund the dev-keypair player**

The dev-keypair port's address is logged/derivable; fund it: `cd redline3d && node scripts/fund-wallet.mjs <DEV_KEYPAIR_ADDR> So11111111111111111111111111111111111111112` (native SOL only). Ensure the master pot is funded (Task 5 Step 3).

- [ ] **Step 3: Drive the happy path in the browser**

Using `preview_*` tools (per [[redline3d-preview-gotchas]] — DOM `.click()`/PointerEvent reach the game; rAF is ~1.5fps so verify via DOM state, bust cache with preview_stop+start):
1. Press GO → session starts (slice_from_pot + delegate under the hood), round opens on the selected asset's feed.
2. Confirm the round is live (HUD shows ×, CASH OUT button), crank armed status.
3. Cash out (or let the crank auto-settle) → outcome + banked balance update.
4. Open the wallet panel → End session (commit_and_undelegate + sweep_till) → Withdraw.

Verify via `preview_console_logs` (no errors), `preview_snapshot` (HUD state transitions), and a final `preview_screenshot` for proof.

- [ ] **Step 4: Confirm the slice/sweep is invisible + bankroll-full message path**

Confirm the player sees no new friction (no "till"/"slice" wording leaks into the UI). Optionally, to exercise the bankroll-full branch, point at a near-empty master pot (or a fresh mint with a tiny `HOUSE_FUND`) and confirm GO surfaces "Tables are full right now…" instead of a crash.

- [ ] **Step 5: Update memory**

Append the sharding milestone to `onchain-er-rebuild.md` (single-pot + per-session-till sharding BUILT & browser-verified, commits range, the sweep-is-separate-L1 mechanics correction vs the spec) and add a one-line index entry if a new memory is warranted.

- [ ] **Step 6: Final review + finish the branch**

Dispatch a final code-review subagent over the full diff (program + client + tests), then use superpowers:finishing-a-development-branch. Do NOT push — all work stays local on `onchain-er-rebuild` per the standing constraint (the user authorizes pushes explicitly).

---

## Notes for the implementer

- **Sweep mechanics (important):** the till sweep is a SEPARATE permissionless L1 `sweep_till`, NOT part of `commit_and_undelegate`. `commit_and_undelegate` runs inside the ER, where the master pot (L1-only, never delegated) is unreachable and undelegation is async — so the client calls `sweep_till` AFTER undelegation lands (the `endSession` flow does this). This corrects the spec's "sweep inside commit_and_undelegate" wording; behavior is identical (single pot, auto-slice, return-on-end).
- **No `Round` field changes** → no `Round::SIZE` change → no post-upgrade fresh-wallet migration. The master `[house, mint]` address is unchanged, so the existing devnet bankroll carries over in-place.
- **Settle math is untouched.** Only the `house` account the settle paths target changes from the singleton to the per-session till.
- **2000× is untouched** (`settle::RMAX = 2000`). No leverage/stake caps added — the slice is `max_payout(selected_stake)`, and the existing open-time coverage check is the only solvency gate.
- **Build-only-what's-asked:** no auto-balancer, no max-stake schedule, no throttle. The only gate is the on-chain "pot can't cover the slice → reject," which is the operator's explicitly-requested behavior. The abandoned-session reclaim reuses the EXISTING permissionless `force_close` + the new permissionless `sweep_till` — no keeper daemon is built (the instructions just make it possible).
