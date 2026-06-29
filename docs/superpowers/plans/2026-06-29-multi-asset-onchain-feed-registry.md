# Multi-asset on-chain (BTC/ETH/SOL) via a feed registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ETH and SOL playable on-chain alongside BTC by replacing the deployed `raider` program's hardcoded BTC feed pin with an admin-managed on-chain feed registry, binding each round to its feed, and wiring the client + the 3D game's asset tabs to pick the round's asset.

**Architecture:** A program-owned `FeedRegistry` PDA (`[b"feeds"]`, admin-authored) maps an asset index → `{feed pubkey, feed_id, enabled}`. `open(asset, …)` validates the passed feed against the registry and **records the feed pubkey on the `Round`**; every settle path (`close`/`force_close`/`flip`/`lever`/`tick`/`tick_crank`) then validates `price_update.key() == round.feed` — so the registry is read only at `open`. One USDC house serves all three assets (settlement is feed-relative).

**Tech Stack:** Anchor 0.32.1 (`~/.avm/bin/anchor-0.32.1`), `ephemeral-rollups-sdk` 0.15.5, Solana devnet + MagicBlock ER. Client: `@coral-xyz/anchor` 0.31 in the browser, Vitest (gated devnet), Claude Preview.

**Spec:** `docs/superpowers/specs/2026-06-29-multi-asset-onchain-feed-registry-design.md`
**Program:** `onchain/raider/` (program id `FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv`, upgradeable — redeploy in place).
**Branch:** `onchain-er-rebuild` (commit locally, do not push).

---

## File Structure

- `onchain/raider/programs/raider/src/state.rs` — add `FeedRegistry` + `FeedEntry`; add `feed: Pubkey` to `Round`; bump `Round::SIZE`.
- `onchain/raider/programs/raider/src/price.rs` — `read_fresh` keeps owner + staleness, drops the hardcoded `BTC_FEED_ID` assert (per-asset identity is bound by `round.feed`/the registry); keep `EXPECTED_FEED_OWNER`. Remove `BTC_FEED`/`BTC_FEED_ID` consts.
- `onchain/raider/programs/raider/src/lib.rs` — `init_feed_registry` + `set_feed` instructions + contexts; `open(asset, …)` registry validation + records `round.feed`; swap the `#[account(address = BTC_FEED)]` pins for `price_update.key() == round.feed` constraints on close/force_close/crank; `schedule_tick` reads `round.feed` for the crank metas.
- `onchain/raider/tests/multiasset.ts` — new gated devnet integration test.
- `redline3d/src/chain/config.ts` — `FEEDS` map + `FEED_REGISTRY` PDA.
- `redline3d/src/chain/chain-round.ts` — per-asset feed + registry account through every method.
- `redline3d/src/chain/game-session.ts` — thread `asset` through `open`, remember the live asset.
- `redline3d/src/main.ts` — drop the Slice-4 BTC-lock; tabs pick the round asset.
- `redline3d/scripts/bootstrap-devnet.mjs` — `init_feed_registry` + `set_feed` for the 3 feeds.
- `redline3d/scripts/probe-feeds.mjs` (new) — Task 0a feed-identity probe (kept as the operator's source of truth).

**Asset index convention (used everywhere):** `0 = BTC, 1 = ETH, 2 = SOL`. `MAX_ASSETS = 8`.

---

## Task 0a: Lock the exact ETH/SOL feed accounts + feed_ids (spike)

**Files:**
- Create: `redline3d/scripts/probe-feeds.mjs`

The on-chain Lazer `feed_id` differs from the client's Hermes hex id. A wrong `feed_id`/account silently settles the wrong asset, so the 3 feeds must be pinned and cross-checked before they go into `set_feed`.

- [ ] **Step 1: Write the probe script**

Create `redline3d/scripts/probe-feeds.mjs`:

```js
// Operator: list the MagicBlock-ER-relayed Pyth Lazer feeds and pick BTC/ETH/SOL.
// Run: node redline3d/scripts/probe-feeds.mjs
import { Connection, PublicKey } from "@solana/web3.js";

const PYTH = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const er = new Connection("https://devnet.magicblock.app", "confirmed");

function decode(buf) {
  let o = 8; o += 32; const tag = buf[o]; o += 1; if (tag === 0) o += 1;
  const feed_id = Buffer.from(buf.subarray(o, o + 32)); o += 32;
  const price = buf.readBigInt64LE(o); o += 8; o += 8;
  const expo = buf.readInt32LE(o);
  return { feed_id: feed_id.toString("hex"), price: Number(price), expo };
}

const accts = await er.getProgramAccounts(PYTH, { filters: [{ dataSize: 134 }] });
const rows = accts.map((a) => {
  const d = decode(a.account.data);
  return { pk: a.pubkey.toBase58(), usd: d.price * Math.pow(10, -Math.abs(d.expo)), feed_id: d.feed_id };
});
const near = (lo, hi) => rows.filter((r) => r.usd >= lo && r.usd < hi).sort((a, b) => b.usd - a.usd);
console.log("BTC:", near(40000, 200000));
console.log("ETH:", near(1000, 5000));
console.log("SOL:", near(80, 400));
```

- [ ] **Step 2: Run it and cross-check**

Run: `node redline3d/scripts/probe-feeds.mjs`
Expected: a BTC row matching the known `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr` / `feed_id 59642ec3…`; ETH + SOL candidate rows. Cross-check the chosen ETH/USD and SOL/USD `feed_id`s against the Pyth Lazer feed registry (Lazer indices BTC=1, ETH=2, SOL=6 — the same indices the client `ASSETS` uses as `lz`). Pick the single canonical ETH/USD and SOL/USD account+`feed_id` each. If two candidates tie on price, the Lazer-registry `feed_id` is the tiebreaker.

- [ ] **Step 3: Record the locked values**

Append the three chosen `{ asset, pubkey, feed_id(hex) }` triples as a comment block at the top of `probe-feeds.mjs` (the operator's source of truth that Task 8 pastes into `bootstrap-devnet.mjs`). Example shape (fill with real Step-2 values):

```
// LOCKED 2026-06-29 (verified vs Lazer registry):
//   BTC  71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr  59642ec3906a38d1267d4aafac36a5e2a47e6d38ed7e5b5843dd287e5e21ab65
//   ETH  <pubkey>                                       <feed_id hex>
//   SOL  <pubkey>                                       <feed_id hex>
```

- [ ] **Step 4: Commit**

```bash
git add redline3d/scripts/probe-feeds.mjs
git commit -m "chore(chain): feed-identity probe + locked BTC/ETH/SOL feeds"
```

---

## Task 0b: Registry-in-rollup read decision (spike)

**Files:** none (a decision + a note); resolved with on-chain reads.

`open` reads the `FeedRegistry` while executing **inside the ER**. The relayed feed accounts are already in the ER (MagicBlock relays them — the program reads `BTC_FEED` in-rollup today), but the registry is a raider-owned L1 account. Decide how `open` sees it.

- [ ] **Step 1: Test clone-on-read**

After Task 3 deploys a program that reads the registry in `open`, the Task 11 ETH integration test IS this probe: if `open` succeeds reading the **non-delegated** registry account passed in the ER tx, clone-on-read works → **Option A (do nothing; registry stays on L1, read-only)**. If `open` fails because the registry account isn't found in the ER, use **Option B**.

- [ ] **Step 2: Option B fallback (only if Step 1 fails)**

One-time **permanent** read-only delegation of the registry to the ER by the admin (NOT per-session — the registry is a global singleton, so it must never be co-delegated inside `delegate_session`, which would make the first session hold it and block all others). Add to `bootstrap-devnet.mjs` a one-shot `delegate` of the `[b"feeds"]` PDA via the same `DelegateConfig{validator}` path; admin updates then go undelegate → `set_feed` → redelegate. The `open` instruction code is identical either way.

- [ ] **Step 3: Record the decision**

Add a one-line note to the spec's "registry-in-rollup" section: `RESOLVED <date>: Option A (clone-on-read)` or `Option B (permanent admin delegation)`.

> **No commit** — this task only gates the bootstrap step in Task 8.

---

## Task 1: `state.rs` — FeedRegistry + Round.feed

**Files:**
- Modify: `onchain/raider/programs/raider/src/state.rs`

- [ ] **Step 1: Write a failing Rust unit test for the new SIZE**

Add to the bottom of `onchain/raider/programs/raider/src/state.rs`:

```rust
#[cfg(test)]
mod size_tests {
    use super::*;
    #[test]
    fn round_size_includes_feed() {
        // 132 (old) + 32 (feed: Pubkey) = 164
        assert_eq!(Round::SIZE, 164);
    }
    #[test]
    fn feed_registry_size_fits_eight_entries() {
        // disc(8) + authority(32) + bump(1) + 8 * (feed 32 + feed_id 32 + enabled 1 = 65) = 561
        assert_eq!(FeedRegistry::SIZE, 8 + 32 + 1 + 8 * 65);
    }
}
```

- [ ] **Step 2: Run it (fails to compile — types absent)**

Run: `cd onchain/raider && cargo test -p raider size_tests 2>&1 | tail -20`
Expected: compile error — `FeedRegistry` not found, `Round` has no `feed`.

- [ ] **Step 3: Add `FeedRegistry`, `FeedEntry`, the seed, and `Round.feed`**

Add the seed alongside the others in `state.rs`:

```rust
pub const FEEDS_SEED: &[u8] = b"feeds";
pub const MAX_ASSETS: usize = 8;
```

Add the registry types:

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct FeedEntry {
    pub feed: Pubkey,       // the MagicBlock-relayed Pyth Lazer price account
    pub feed_id: [u8; 32],  // decoded Lazer feed_id (defense-in-depth at open)
    pub enabled: bool,
}

#[account]
pub struct FeedRegistry {
    pub authority: Pubkey,
    pub feeds: [FeedEntry; MAX_ASSETS], // indexed by asset id (0=BTC,1=ETH,2=SOL)
    pub bump: u8,
}
impl FeedRegistry {
    pub const SIZE: usize = 8 + 32 + MAX_ASSETS * (32 + 32 + 1) + 1;
}
```

Add `feed` to `Round` (after `owner`, before `dir` — field order is part of the layout, keep it stable for the IDL):

```rust
#[account]
pub struct Round {
    pub owner: Pubkey,
    pub feed: Pubkey, // the price feed this round opened on (bound at open; validated on every settle)
    pub dir: i8,
    // ...unchanged fields...
}
```

Update `Round::SIZE`:

```rust
impl Round {
    // disc(8) + owner(32) + feed(32) + dir(1) + lev(4) + stake(8) + entry_raw(8)
    //  + entry_expo(4) + entry_ts(8) + banked(16) + max_payout(8) + deadline_ts(8)
    //  + status(1) + bump(1) + exit_raw(8) + exit_ts(8) + payout(8) + outcome(1) = 164
    pub const SIZE: usize =
        8 + 32 + 32 + 1 + 4 + 8 + 8 + 4 + 8 + 16 + 8 + 8 + 1 + 1 + 8 + 8 + 8 + 1;
}
```

- [ ] **Step 4: Run the test (passes)**

Run: `cd onchain/raider && cargo test -p raider size_tests 2>&1 | tail -20`
Expected: `test result: ok. 2 passed`.

- [ ] **Step 5: Commit**

```bash
git add onchain/raider/programs/raider/src/state.rs
git commit -m "feat(raider): FeedRegistry + Round.feed (multi-asset state)"
```

---

## Task 2: `price.rs` — per-asset read_fresh

**Files:**
- Modify: `onchain/raider/programs/raider/src/price.rs`

`read_fresh` no longer asserts the BTC feed_id (identity is now bound by `round.feed` / validated at open against the registry). It keeps the owner + two-sided staleness checks and returns the snapshot (which still carries the decoded `feed_id`, so `open` can do the per-asset defense-in-depth check).

- [ ] **Step 1: Remove the BTC consts + the feed_id assert**

In `price.rs`, delete the `BTC_FEED` const (lines ~30-33) and the `BTC_FEED_ID` const (lines ~43-49). Keep `EXPECTED_FEED_OWNER`. In `read_fresh`, delete the final block:

```rust
    // (3) The decoded message must be the BTC/USD feed.
    require!(snap.feed_id == BTC_FEED_ID, RaiderError::UntrustedFeed);
```

So `read_fresh` ends `Ok(snap)` right after the staleness checks. (Owner + staleness remain; the returned `snap.feed_id` is used by `open`.)

- [ ] **Step 2: Verify it compiles (the consts are referenced elsewhere — those move to Tasks 3-6)**

Run: `cd onchain/raider && cargo build -p raider 2>&1 | grep -E "BTC_FEED|error" | head`
Expected: errors ONLY of the form `cannot find ... BTC_FEED` at the lib.rs pin sites (OpenRound/CloseRound/ForceCloseRound/CrankClose/ScheduleTick + schedule_tick metas). These are fixed in Tasks 4-6. (This confirms exactly which sites still reference the removed const.)

- [ ] **Step 3: Commit**

```bash
git add onchain/raider/programs/raider/src/price.rs
git commit -m "feat(raider): read_fresh drops hardcoded BTC feed_id (per-asset binding)"
```

---

## Task 3: `lib.rs` — registry instructions (`init_feed_registry`, `set_feed`)

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs`

Admin-only, L1. Create the registry, set one feed entry.

- [ ] **Step 1: Add the two instructions**

In `lib.rs`, inside `pub mod raider`, after `init_house` (before `buy_in`):

```rust
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
```

- [ ] **Step 2: Add the contexts**

In the "Account contexts" section of `lib.rs` (after `InitHouse`):

```rust
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
```

- [ ] **Step 3: Add the `UnknownAsset` error**

In `RaiderError`, add a variant:

```rust
    /// open/set_feed got an asset index outside the registry, or an unregistered/disabled feed.
    UnknownAsset,
```

- [ ] **Step 4: Import the new state types**

Update the `use state::{...}` line near the top of `lib.rs` to include `FeedRegistry` and the seed:

```rust
use state::{FeedRegistry, HouseBalance, PlayerBalance, Round};
use state::{FEEDS_SEED, HOUSE_SEED, MAX_ROUND_SECS, PLAYER_SEED, ROUND_SEED, STALE_SECS, VAULT_SEED};
```

(`MAX_ASSETS`/`FeedEntry` are referenced as `state::MAX_ASSETS` / `state::FeedEntry` above, so no extra import needed; add them to the `use` if you prefer unqualified.)

- [ ] **Step 5: It will not fully build yet (Task 2's removed const still referenced by open/close/etc).** Verify only the new items compile in isolation:

Run: `cd onchain/raider && cargo build -p raider 2>&1 | grep -E "init_feed_registry|set_feed|InitFeedRegistry|SetFeed|UnknownAsset" | head`
Expected: NO errors naming the new items (remaining errors are the Task-2 `BTC_FEED` sites, fixed next).

- [ ] **Step 6: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs
git commit -m "feat(raider): init_feed_registry + set_feed (admin registry instructions)"
```

---

## Task 4: `lib.rs` — `open(asset)` validates the registry + records `round.feed`

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs`

- [ ] **Step 1: Change the `open` signature + add the registry validation**

Replace the `open` handler signature and the price-read block. New signature adds `asset: u8`; after `read_fresh`, look up the registry, require the passed feed matches + enabled + feed_id matches, and record `round.feed`:

```rust
    pub fn open(ctx: Context<OpenRound>, asset: u8, dir: i8, lev: u32, stake: u64) -> Result<()> {
        require!(lev >= settle::RMIN && lev <= settle::RMAX, RaiderError::BadLeverage);
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
        require!(snap.price > 0, RaiderError::BadPrice);
        // ...rest of open unchanged until the round writes...
```

Then in the round-write block of `open`, add `round.feed = ctx.accounts.price_update.key();` next to `round.owner = player.owner;`:

```rust
        round.owner = player.owner;
        round.feed = ctx.accounts.price_update.key();
        round.dir = dir;
        // ...unchanged...
```

- [ ] **Step 2: Update the `OpenRound` context — drop the BTC pin, add the registry**

Replace the `price_update` field in `OpenRound` and add the registry account:

```rust
    /// CHECK: must equal registry.feeds[asset].feed (checked in the handler); the bytes are
    /// authenticated (owner + staleness) by price::read_fresh().
    pub price_update: AccountInfo<'info>,
    #[account(seeds = [FEEDS_SEED], bump = registry.bump)]
    pub registry: Account<'info, FeedRegistry>,
    pub player_authority: Signer<'info>,
```

(Remove the `#[account(address = price::BTC_FEED)]` attribute from `price_update`.)

- [ ] **Step 3: Build the program**

Run: `cd onchain/raider && cargo build -p raider 2>&1 | grep -E "open|OpenRound|error\[" | head`
Expected: no `open`/`OpenRound` errors (remaining `BTC_FEED` errors are only in close/force_close/crank/schedule — fixed in Tasks 5-6).

- [ ] **Step 4: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs
git commit -m "feat(raider): open(asset) validates registry + records round.feed"
```

---

## Task 5: `lib.rs` — settle paths validate `price_update == round.feed`

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs`

`close`/`force_close`/`flip`/`lever`/`tick` all use `CloseRound` or `ForceCloseRound`. Both contexts already deserialize `round`, so the feed binding is a one-line constraint swap (drop the BTC address pin, require the passed feed equals the round's recorded feed).

- [ ] **Step 1: Swap the pin in `CloseRound`**

In `CloseRound`, replace the `price_update` field:

```rust
    /// CHECK: must equal round.feed (the feed this round opened on); authenticated by read_fresh.
    #[account(constraint = price_update.key() == round.feed @ RaiderError::UntrustedFeed)]
    pub price_update: AccountInfo<'info>,
```

- [ ] **Step 2: Swap the pin in `ForceCloseRound`**

Identical change to the `price_update` field in `ForceCloseRound`:

```rust
    /// CHECK: must equal round.feed; permissionless, so the round-bound feed is the guard. Authenticated by read_fresh.
    #[account(constraint = price_update.key() == round.feed @ RaiderError::UntrustedFeed)]
    pub price_update: AccountInfo<'info>,
```

- [ ] **Step 3: Build**

Run: `cd onchain/raider && cargo build -p raider 2>&1 | grep -E "CloseRound|ForceClose|error\[" | head`
Expected: no `CloseRound`/`ForceCloseRound` errors (remaining `BTC_FEED` errors only in `CrankClose` + `ScheduleTick` + `schedule_tick` metas).

- [ ] **Step 4: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs
git commit -m "feat(raider): close/force_close/flip/lever validate round.feed"
```

---

## Task 6: `lib.rs` — crank uses the round's feed

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs`

The native crank hardcodes `price::BTC_FEED` in two `AccountMeta`s and pins it in `CrankClose` + `ScheduleTick`. `schedule_tick` must read `round.feed` and forward it; `CrankClose` must validate against `round.feed`.

- [ ] **Step 1: `CrankClose` — validate the round's feed**

Replace the `price_update` field in `CrankClose`:

```rust
    /// CHECK: must equal round.feed; the no-signer crank is bound to the round's feed. Authenticated by read_fresh.
    #[account(constraint = price_update.key() == round.feed @ RaiderError::UntrustedFeed)]
    pub price_update: AccountInfo<'info>,
```

- [ ] **Step 2: `ScheduleTick` — make `round` typed + bind the feed**

`schedule_tick` needs to read `round.feed`, so `round` becomes a read-only typed `Account` (no `mut`, so Anchor reads but never re-serializes). Replace the `round` and `price_update` fields in `ScheduleTick`:

```rust
    /// Round PDA — typed read so we can forward round.feed into the scheduled metas.
    #[account(seeds = [ROUND_SEED, round.owner.as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    /// CHECK: mint, forwarded to the scheduled-ix metas
    pub mint: UncheckedAccount<'info>,
    /// CHECK: must equal round.feed; forwarded to the scheduled-ix metas. Authenticated by read_fresh at run time.
    #[account(constraint = price_update.key() == round.feed @ RaiderError::UntrustedFeed)]
    pub price_update: AccountInfo<'info>,
```

(Keep `player`/`house` as `UncheckedAccount` — only `round` needs to be typed to read `.feed`. Remove the `#[account(address = price::BTC_FEED)]` from `price_update`.)

- [ ] **Step 3: `schedule_tick` body — use `round.feed` in both metas**

In `schedule_tick`, replace both `AccountMeta::new_readonly(price::BTC_FEED, false)` occurrences with the round's feed:

```rust
        let feed = ctx.accounts.round.feed;
        // ...in tick_ix.accounts:
            AccountMeta::new_readonly(feed, false),
        // ...and in schedule_ix accounts:
            AccountMeta::new_readonly(feed, false),
```

(Define `let feed = ctx.accounts.round.feed;` once at the top of the handler; use it in both vecs. The `invoke_signed` account-infos list already passes `ctx.accounts.price_update` — which the Step-2 constraint now guarantees equals `round.feed` — so no change there.)

- [ ] **Step 4: Build the whole program clean**

Run: `cd onchain/raider && cargo build -p raider 2>&1 | tail -20`
Expected: builds with no errors (warnings ok). `grep -rn BTC_FEED onchain/raider/programs/` returns nothing.

- [ ] **Step 5: Run the Rust unit suite**

Run: `cd onchain/raider && cargo test -p raider 2>&1 | tail -15`
Expected: existing settle/size unit tests pass (the settle math is untouched).

- [ ] **Step 6: Commit**

```bash
git add onchain/raider/programs/raider/src/lib.rs
git commit -m "feat(raider): native crank forwards round.feed (multi-asset crank)"
```

---

## Task 7: Build + redeploy to devnet + sync the IDL

**Files:**
- Modify: `redline3d/src/chain/idl/raider.json`, `redline3d/src/chain/idl/raider.ts` (regenerated)

- [ ] **Step 1: Confirm the deploy keypair has SOL**

Run: `solana balance -k ~/.config/solana/lazer-probe.json -u devnet`
Expected: ≥ ~3 SOL (the upgrade needs ~2.7). If short, consolidate keypairs / faucet as in Phase 1 (`solana airdrop 2 -k … -u devnet`, retry on rate-limit) BEFORE building.

- [ ] **Step 2: Build the deployable + redeploy (program id unchanged, upgrade in place)**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build && ~/.avm/bin/anchor-0.32.1 deploy --provider.cluster devnet 2>&1 | tail -20`
Expected: `Deploy success`, same program id `FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv`.

- [ ] **Step 3: Sync the IDL into the client**

Run: `cp onchain/raider/target/idl/raider.json redline3d/src/chain/idl/raider.json && cp onchain/raider/target/types/raider.ts redline3d/src/chain/idl/raider.ts`
Expected: the new `init_feed_registry`/`set_feed` instructions + `open`'s `asset` arg + `round.feed`/`FeedRegistry` appear in the IDL (`grep -c feedRegistry redline3d/src/chain/idl/raider.json` > 0).

- [ ] **Step 4: Verify the client still typechecks against the new IDL**

Run: `cd redline3d && npx tsc --noEmit 2>&1 | tail -20`
Expected: errors ONLY where `chain-round.ts` calls `open`/the feed contexts with the old shape (fixed in Task 9). If `tsc` is clean, even better.

- [ ] **Step 5: Commit**

```bash
git add onchain/raider/target/idl/raider.json onchain/raider/target/types/raider.ts redline3d/src/chain/idl/raider.json redline3d/src/chain/idl/raider.ts
git commit -m "build(raider): redeploy multi-asset program + sync IDL"
```

---

## Task 8: Bootstrap — register the 3 feeds (+ optional registry delegation)

**Files:**
- Modify: `redline3d/scripts/bootstrap-devnet.mjs`

- [ ] **Step 1: Add registry init + set_feed for the 3 locked feeds**

In `bootstrap-devnet.mjs`, after the house funding block, add (paste the Task-0a-locked pubkeys/feed_ids):

```js
// --- feed registry (multi-asset) ---
const [registry] = PublicKey.findProgramAddressSync([Buffer.from("feeds")], program.programId);
const existingReg = await program.account.feedRegistry.fetchNullable(registry);
if (!existingReg) {
  await program.methods.initFeedRegistry().accounts({ authority: funder.publicKey, registry, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
  console.log("init_feed_registry done");
}
const FEEDS = [
  { asset: 0, pk: "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr", feed_id: "59642ec3906a38d1267d4aafac36a5e2a47e6d38ed7e5b5843dd287e5e21ab65" },
  { asset: 1, pk: "<ETH pubkey from Task 0a>", feed_id: "<ETH feed_id hex>" },
  { asset: 2, pk: "<SOL pubkey from Task 0a>", feed_id: "<SOL feed_id hex>" },
];
for (const f of FEEDS) {
  await program.methods
    .setFeed(f.asset, new PublicKey(f.pk), [...Buffer.from(f.feed_id, "hex")], true)
    .accounts({ authority: funder.publicKey, registry })
    .rpc({ skipPreflight: true });
  console.log("set_feed", f.asset, f.pk);
}
console.log("feeds registered");
```

- [ ] **Step 2: If Task 0b chose Option B, add the one-time registry delegation**

(Skip if Task 0b resolved to Option A / clone-on-read.) Add a `delegate`-style call for the `[b"feeds"]` PDA via the program's delegation path — only if Task 11's ETH open fails on a non-delegated registry. Document the chosen option inline.

- [ ] **Step 3: Run the bootstrap against the existing demo mint**

Run: `ANCHOR_WALLET=$HOME/.config/solana/lazer-probe.json node redline3d/scripts/bootstrap-devnet.mjs 2JSMTdCiBXNrqGveNDDxcpoR7So2z1H9w9is8FrDhMn1 2>&1 | grep -vE "429|Retrying" | tail`
Expected: `init_feed_registry done` (first run) + 3× `set_feed` + `feeds registered`. (Reusing the Task-0a 2JSMT house; or pass no mint for a fresh one.)

- [ ] **Step 4: Verify the registry on-chain**

Run: `cd redline3d && node --input-type=module -e 'import {Connection,PublicKey} from "@solana/web3.js"; import anchor from "@coral-xyz/anchor"; import idl from "./src/chain/idl/raider.json" with {type:"json"}; const PROGRAM=new PublicKey("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv"); const c=new Connection("https://api.devnet.solana.com","confirmed"); const p=new anchor.Program(idl,new anchor.AnchorProvider(c,{publicKey:PROGRAM,signTransaction:async t=>t,signAllTransactions:async t=>t},{})); const [r]=PublicKey.findProgramAddressSync([Buffer.from("feeds")],PROGRAM); const reg=await p.account.feedRegistry.fetch(r); reg.feeds.slice(0,3).forEach((f,i)=>console.log(i, f.feed.toBase58(), f.enabled));' 2>&1 | tail -4`
Expected: 3 enabled feeds at indices 0/1/2 with the BTC/ETH/SOL pubkeys.

- [ ] **Step 5: Commit**

```bash
git add redline3d/scripts/bootstrap-devnet.mjs
git commit -m "feat(chain): bootstrap registers BTC/ETH/SOL feeds"
```

---

## Task 9: Client — per-asset feed + registry in `chain-round.ts`

**Files:**
- Modify: `redline3d/src/chain/config.ts`, `redline3d/src/chain/chain-round.ts`

- [ ] **Step 1: Add the FEEDS map + registry PDA to config**

In `config.ts`, inside `CHAIN`, add (BTC_FEED stays as the BTC entry):

```ts
  // Multi-asset Lazer feeds (Task 0a). Keyed by the game's asset id.
  FEEDS: {
    BTC: new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"),
    ETH: new PublicKey("<ETH pubkey from Task 0a>"),
    SOL: new PublicKey("<SOL pubkey from Task 0a>"),
  } as Record<"BTC" | "ETH" | "SOL", PublicKey>,
  ASSET_ID: { BTC: 0, ETH: 1, SOL: 2 } as Record<"BTC" | "ETH" | "SOL", number>,
```

And derive the registry PDA where the other PDAs are derived (in `deriveRaiderPdas` or as a const next to it):

```ts
export function deriveFeedRegistry(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("feeds")], programId)[0];
}
```

- [ ] **Step 2: Thread asset + feed + registry through `chain-round.ts`**

In `createChainRound`, derive the registry once and add an asset→feed helper:

```ts
  const registry = deriveFeedRegistry(CHAIN.PROGRAM_ID);
  const feedFor = (asset: "BTC" | "ETH" | "SOL") => CHAIN.FEEDS[asset];
```

Change `open` to take an asset, pass the asset id + that feed + the registry:

```ts
    async open(asset, dir, lev, stake) {
      const feed = feedFor(asset);
      await send(erConn, programER.methods.open(CHAIN.ASSET_ID[asset], dir, lev, new BN(stake)).accountsPartial({
        player: pdas.player, house: pdas.house, round: pdas.round, mint,
        priceUpdate: feed, registry, playerAuthority: owner,
      }));
      const r = await programER.account.round.fetch(pdas.round);
      return { entryRaw: BigInt(r.entryRaw.toString()), entryExpo: Number(r.entryExpo), entryHuman: rawToHuman(BigInt(r.entryRaw.toString()), Number(r.entryExpo)), deadlineTs: Number(r.deadlineTs), feed: r.feed.toBase58() };
    },
```

For `close`/`flip`/`lever`/`forceClose`/`scheduleCrank`, the feed must equal `round.feed`. Read it from the round (or accept it from the caller). Add a tiny cached read + use it:

```ts
    async roundFeed(onEr = true) {
      const r = await (onEr ? programER : program).account.round.fetchNullable(pdas.round);
      return r ? new PublicKey(r.feed) : feedFor("BTC");
    },
```

Then in `close`/`flip`/`lever`/`forceClose` swap `priceUpdate: CHAIN.BTC_FEED` for `priceUpdate: await this.roundFeed()` (or thread the live feed from the session — see Task 10). For `scheduleCrank`, the `ScheduleTick` context now also needs no feed pin but the same `priceUpdate: round.feed` + the typed round; pass `priceUpdate: await this.roundFeed()`.

Update the `OpenedRound` type (`chain-round.ts`) to include `feed: string`, and the `ChainRound` interface `open(asset: "BTC"|"ETH"|"SOL", dir, lev, stake)`.

- [ ] **Step 3: Typecheck**

Run: `cd redline3d && npx tsc --noEmit 2>&1 | tail -20`
Expected: errors now only in `game-session.ts`/`main.ts` callers of `open` (fixed Task 10).

- [ ] **Step 4: Commit**

```bash
git add redline3d/src/chain/config.ts redline3d/src/chain/chain-round.ts
git commit -m "feat(chain): per-asset feed + registry in chain-round"
```

---

## Task 10: Game — `game-session` + `main.ts` pick the asset

**Files:**
- Modify: `redline3d/src/chain/game-session.ts`, `redline3d/src/main.ts`

- [ ] **Step 1: Thread asset through `game-session.open`**

In `game-session.ts`, change `open` to accept the asset and pass it:

```ts
    async open(asset, dir, lev, stakeBase) {
      const c = need();
      const opened = await c.open(asset, dir, lev, stakeBase);
      armed = false;
      try { await c.scheduleCrank(); armed = true; } catch { armed = false; }
      return opened;
    },
```

Update the `GameSession` interface `open(asset: "BTC"|"ETH"|"SOL", dir, lev, stakeBase)`.

- [ ] **Step 2: `main.ts` — drop the BTC-lock, pass the active asset to open**

Delete the Slice-4 BTC-lock block in `controls.onLaunch` (the `if (asset !== "BTC") { … }` lines). Change the open call to pass the active asset:

```ts
      opened = await session.open(asset as "BTC" | "ETH" | "SOL", dir, lev, centsToBase(playAmount));
```

(`asset` is the existing module var the BTC/ETH/SOL tabs set; `hud.onAsset` already blocks switching mid-round, so the round's asset is locked once live.)

- [ ] **Step 3: Typecheck**

Run: `cd redline3d && npx tsc --noEmit 2>&1 | tail -20`
Expected: clean.

- [ ] **Step 4: Run the full unit suite (no regressions)**

Run: `cd redline3d && npm test 2>&1 | tail -8`
Expected: PASS (192 + any new). The 2 gated devnet tests skip.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/chain/game-session.ts redline3d/src/main.ts
git commit -m "feat(game): asset tabs pick the on-chain round asset"
```

---

## Task 11: Gated devnet integration — ETH/SOL/negative/crank

**Files:**
- Create: `onchain/raider/tests/multiasset.ts` (or extend `redline3d/src/chain/chain-round.devnet.test.ts`)

Use the existing `chain-round.devnet.test.ts` harness (fresh wallets, polyfill-free `vitest.config.devnet.ts`). This is ALSO the Task-0b clone-on-read probe.

- [ ] **Step 1: Write the gated test**

Add to `redline3d/src/chain/chain-round.devnet.test.ts` a 3rd `it` (registry must already be bootstrapped on the test mint — the test bootstraps its own fresh mint + registers feeds, or reuses the demo registry; for isolation, register feeds on the fresh mint's run is N/A since the registry is global → reuse the global registry, create a fresh mint+house, fund a fresh player):

```ts
it("opens an ETH round and settles on the ETH feed; rejects the wrong feed", async () => {
  // ...standard setup: fresh mint + funded house + funded dev-keypair player (as in the other tests)...
  const chain = createChainRound({ wallet: portToAnchorWallet(port), mint });
  await chain.buyIn(5_000_000);
  await chain.ensureRoundInited();
  await chain.delegate();

  // open ETH (asset 1) — proves the registry read in-rollup (Task 0b) + per-asset binding
  const opened = await chain.open("ETH", 1, 100, 1_000_000);
  expect(opened.entryHuman).toBeGreaterThan(500);   // ETH in the hundreds/thousands
  expect(opened.feed).toBe(CHAIN.FEEDS.ETH.toBase58());
  expect(await chain.readRoundStatus(true)).toBe(1);

  await sleep(6000);
  const settled = await chain.close();               // close passes round.feed (ETH)
  expect(["cashout","cap","liq","time"]).toContain(settled.outcomeName);
  expect(settled.balance).toBe(5_000_000n - 1_000_000n + settled.payout);

  await chain.commitAndUndelegate();
}, 180_000);
```

Add a **negative** assertion (open ETH, then attempt a raw close with the BTC feed → rejected). Since `chain.close()` always uses `round.feed`, the negative path is a direct `programER.methods.close()` call passing `priceUpdate: CHAIN.FEEDS.BTC` and asserting it throws (the `price_update.key() == round.feed` constraint rejects it):

```ts
// inside the test, after open ETH and before close:
await expect(
  send(erConn, programER.methods.close().accountsPartial({
    player: pdas.player, house: pdas.house, round: pdas.round, mint,
    priceUpdate: CHAIN.FEEDS.BTC, playerAuthority: owner,
  }))
).rejects.toThrow(); // UntrustedFeed: BTC feed != round.feed (ETH)
```

(Expose `erConn`/`programER`/`pdas`/`send` for the test, or replicate the minimal builder; simplest is a small negative helper on `chain` like `closeWithFeed(feed)` used only by the test.)

- [ ] **Step 2: Run the gated test**

Run: `cd redline3d && RAIDER_DEVNET=1 ANCHOR_WALLET=$HOME/.config/solana/lazer-probe.json npx vitest run --config vitest.config.devnet.ts -t "opens an ETH round" 2>&1 | tail -20`
Expected: PASS. **If `open` fails to find the registry account in the ER → Task 0b Option B** (delegate the registry once via the bootstrap), then re-run. A SOL variant (`chain.open("SOL", …)`) + a crank variant (`scheduleCrank` on a SOL round auto-settles) can be added as further `it`s.

- [ ] **Step 3: Commit**

```bash
git add redline3d/src/chain/chain-round.devnet.test.ts redline3d/src/chain/chain-round.ts
git commit -m "test(chain): devnet ETH/SOL multi-asset round + wrong-feed rejection"
```

---

## Task 12: Browser verification — SOL + ETH rounds in the 3D game

**Files:** none (verification). Per the verify-in-browser rule.

- [ ] **Step 1: Restart the preview to load the new bundle**

`preview_stop` then `preview_start` (`redline3d`). Confirm `redline3d render up`, no console errors. (The `perps-server` :8080 from Slice 4 can stay up for the lobby/identity.)

- [ ] **Step 2: Fund the Preview's dev wallet on the demo mint**

Read the dev-keypair address (localStorage `redline.chain.devkey.v1`), then `node redline3d/scripts/fund-wallet.mjs <ADDR> 2JSMTdCiBXNrqGveNDDxcpoR7So2z1H9w9is8FrDhMn1`. Reload.

- [ ] **Step 3: Play a SOL round**

Tap the **SOL** asset tab. Press GO → confirm the HUD price reads SOL (~$200), the live × tracks SOL (not ×0.00), and the round opens on-chain (`readRound().feed == FEEDS.SOL`). Cash out or let the crank settle; confirm the settled badge + balance update. Use `preview_eval`/`preview_screenshot` for evidence (rAF is throttled — drive via DOM state).

- [ ] **Step 4: Play an ETH round**

Tap **ETH**, GO, confirm the × tracks ETH (~$1.6k) and it settles correctly.

- [ ] **Step 5: End session + capture proof**

End session + Withdraw (from the wallet footer). `preview_screenshot` of a live SOL round and a live ETH round; share both. `preview_stop`.

- [ ] **Step 6: Revert the test-only config edit**

If `config.ts` still points at the throwaway demo mint from Slice-4 testing, decide with the user whether the demo mint becomes the committed default or revert to the prior mint. (No code commit in this task.)

---

## Self-Review

**1. Spec coverage:**
- Feed registry (admin PDA) → Tasks 1, 3, 8. ✅
- `read_fresh(expected feed)` → Task 2 (drops the BTC const; open does the per-asset feed_id check). ✅
- `open(asset)` validates + records → Task 4. ✅
- close/tick/flip/lever/force_close/crank validate round.feed → Tasks 5, 6. ✅
- Redeploy + IDL → Task 7. ✅
- Client + game (tabs pick asset, drop BTC-lock) → Tasks 9, 10. ✅
- Bootstrap set_feed → Task 8. ✅
- Tests (Rust unit, gated devnet ETH/SOL/negative/crank, Preview) → Tasks 1, 6, 11, 12. ✅
- Task 0a feed identity + Task 0b registry-in-rollup → Tasks 0a, 0b (0b folded into Task 11's open). ✅
- Registry-in-rollup narrowed to `open` only (round.feed stored) → design choice realized in Tasks 4-6. ✅

**2. Placeholder scan:** The only intentional fill-ins are the **Task-0a-derived ETH/SOL pubkeys + feed_ids** (`<ETH pubkey>` etc.) — these are *outputs of Task 0a* consumed by Tasks 8/9, explicitly flagged, not vague requirements. Everything else is concrete code + exact commands.

**3. Type consistency:** `open(asset, dir, lev, stake)` signature is consistent across the Rust handler (Task 4), `chain-round.ts` (Task 9), `game-session.ts` (Task 10), and `main.ts` (Task 10). `round.feed` (Pubkey) is written in Task 4 and read in Tasks 5/6/9. `FeedRegistry`/`FeedEntry`/`MAX_ASSETS`/`FEEDS_SEED` defined in Task 1, used in Tasks 3/4. `UnknownAsset`/`UntrustedFeed` errors defined where first used. `Round::SIZE = 164` consistent (Task 1) with the field add.

**Migration note (devnet):** `Round` grows 132→164, so round PDAs created before this upgrade can't deserialize — post-upgrade testing/demo uses **fresh dev-keypair wallets** (each browser already gets a fresh keypair; the gated tests already `Keypair.generate()`). No migration instruction needed. Old abandoned rounds (e.g. `8RbT6…`) are throwaway devnet data.
