# Multi-asset on-chain (BTC/ETH/SOL) via a feed registry — design

**Date:** 2026-06-29
**Branch:** `onchain-er-rebuild`
**Status:** design — approved, pending spec review before writing-plans
**Predecessor:** Client Slice 4 (`2026-06-29-client-slice4-game-fold-design.md`) folded the on-chain round into the real 3D game, BTC-only (the deployed `raider` program hard-pins BTC). This slice makes ETH and SOL play on-chain too.

## Goal

Make **ETH and SOL** playable on-chain alongside BTC. The deployed `raider` program is hard-pinned to a single BTC feed (`price::BTC_FEED` const + `read_fresh` owner/feed_id asserts + `#[account(address = BTC_FEED)]` on open/close/force_close + the native crank hardcodes `BTC_FEED`). Replace that single pin with an **admin-managed on-chain feed registry**, store which asset a round opened on, and validate every settle path against that asset's registered feed. Wire the client + the 3D game's existing BTC/ETH/SOL tabs to pick the round's asset. Devnet, redeploy.

## Feasibility (verified 2026-06-29)

The devnet MagicBlock ER (`https://devnet.magicblock.app`) relays **175 Pyth-Lazer feeds**, all owned by the Pyth receiver `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` (134-byte `PriceUpdateV2` accounts). Confirmed by probing `getProgramAccounts(PriCe…, dataSize 134)` and decoding price/feed_id:
- **BTC** `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr` — $60,122, `feed_id 59642ec3906a38d1267d4aafac36a5e2a47e6d38ed7e5b5843dd287e5e21ab65` (matches the deployed program const ✓).
- **ETH candidates** (~$1.6k): `GzUcFuvSo5DkY7B8o2P7rYsLJ3VmRb7FvdF1aQWkxxic` (`ed98a058…`), `5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG` (`492876f1…`).
- **SOL candidates** (~$200): `2MtF3H7Wzkp3xM6G9gdqJp55Aht1QrQdTagCKmHqJUJj` (`14353e20…`), `a4Zj6ZkuzniMBqdN6JDpEkTEuLQKd3THxydXnbpqzH8` (`0878326…`).

ETH/SOL feeds exist on the ER, so the slice is buildable. The **exact** canonical ETH/USD and SOL/USD feed accounts + `feed_id`s must be confirmed against the Lazer feed registry before they're registered (a wrong `feed_id` would silently settle the wrong asset) — that is **Task 0**.

## Architecture

A program-owned **`FeedRegistry`** PDA `[b"feeds"]` (singleton) is the trust root, replacing the hardcoded BTC consts:

```
FeedRegistry {
  authority: Pubkey,             // admin; only it may write the registry
  feeds: [FeedEntry; MAX_ASSETS] // indexed by asset id (0=BTC, 1=ETH, 2=SOL); MAX_ASSETS = 8 (room to grow)
  bump: u8,
}
FeedEntry { feed: Pubkey, feed_id: [u8; 32], enabled: bool }  // zeroed/disabled by default
```

The security guarantee is identical to the hardcoded pin — a round can only ever settle against a feed the admin registered — but adding a market is a `set_feed` call, not a redeploy. The shared **owner** check (`EXPECTED_FEED_OWNER = PriCe…`, identical for all Lazer feeds) stays a const; only the per-asset `feed` pubkey + `feed_id` move into the registry.

### The registry-in-rollup wrinkle (the one cost vs hardcoded consts)

`open`/`close`/`tick`/`flip`/`lever` execute **inside** the ER, so they must read the registry in-rollup. Consts came compiled into the binary (available everywhere); a real account does not. **Task 0b is a spike** to confirm MagicBlock clones a read-only L1 account into the ER when it is referenced by an ER transaction (the standard read-only-config pattern). If clone-on-read does not work cleanly, the fallback is to **delegate the registry read-only to the ER** once (admin updates it via undelegate → `set_feed` → redelegate). The read path is proven before anything is built on it.

> **RESOLVED 2026-06-29: Option A (clone-on-read).** The gated devnet ETH-open test (`chain-round.devnet.test.ts`) opened a round inside the ER against the **non-delegated** L1 registry `[b"feeds"]` and it bound to the ETH feed + settled conserved — MagicBlock clones the registry into the ER on reference. No registry delegation needed. (Note: only `open` reads the registry; `close`/`flip`/`lever`/`tick`/`crank` validate `price_update.key() == round.feed` against the feed `open` stamped on the `Round`, so the registry is read exactly once per round.)

## Components

### Program (`onchain/raider/programs/raider/src/`)
- **`state.rs`**: add `FeedRegistry` + `FeedEntry`; add `asset: u8` to `Round` (the asset id the round opened on). The current `Round` allocates `SIZE` 132 vs ~107 used (Phase-2 reserve), so `asset: u8` should fit the existing allocation with **no realloc/migration** — confirm during implementation; if not, existing devnet round accounts (throwaway test data) are closed + re-`init_round`ed.
- **`price.rs`**: `read_fresh(price_acct, now, expected_feed_id: &[u8;32])` keeps the owner + two-sided staleness checks and asserts `snap.feed_id == *expected_feed_id` (passed by the caller from the registry lookup) instead of the hardcoded `BTC_FEED_ID`. The `BTC_FEED`/`BTC_FEED_ID` consts are removed (the registry supersedes them); `EXPECTED_FEED_OWNER` stays.
- **`lib.rs`**:
  - `init_feed_registry(authority)` — create the registry, set `authority`. Admin/one-time, L1.
  - `set_feed(asset: u8, feed: Pubkey, feed_id: [u8;32], enabled: bool)` — `has_one = authority` (admin-gated), writes `feeds[asset]`. L1.
  - `open(asset: u8, dir, lev, stake)` — require `asset < MAX_ASSETS` and `feeds[asset].enabled`; require the passed `price_update` key == `feeds[asset].feed`; `read_fresh(price_update, now, &feeds[asset].feed_id)`; record `round.asset = asset`. Replaces the `#[account(address = BTC_FEED)]` pin with an in-handler `require_keys_eq!(price_update.key(), feeds[asset].feed)`.
  - `close`/`tick`/`flip`/`lever`/`force_close` — look up `feeds[round.asset]`, require the passed `price_update` == that feed, `read_fresh(…, &feeds[round.asset].feed_id)`.
  - **native crank** (`schedule_tick` → `tick_crank`): the scheduled instruction's `AccountMeta` for the feed becomes `feeds[round.asset].feed` (read from the round at schedule time) instead of hardcoded `price::BTC_FEED`; the registry account is added to the crank's account list.
  - Every settle context gains the `FeedRegistry` account (read-only).

### Client (`redline3d/src/chain/`)
- **`config.ts`**: a `FEEDS` map `{ BTC, ETH, SOL } → PublicKey` (the registered feed accounts) + the `FeedRegistry` PDA; keep `BTC_FEED` as `FEEDS.BTC` for back-compat.
- **`chain-round.ts`**: `open(asset, dir, lev, stake)` passes `asset` + `FEEDS[asset]` + the registry; `close`/`flip`/`lever`/`scheduleCrank`/`readRound`/`forceClose` use the round's asset feed (read `round.asset` or carry it on the session) + the registry. The `asset → feed` mapping lives in one helper.
- **`game-session.ts`**: `open(asset, …)` threads the asset through; the controller remembers the live round's asset for the settle/crank calls.

### Game (`redline3d/src/main.ts`)
- Drop the Slice-4 BTC-lock (`if (asset !== "BTC") …`). The existing `hud.onAsset` tabs (BTC/ETH/SOL, already blocked mid-round) set the asset that `open` sends; the local engine × already runs off `priceSource` for the active asset, so it matches the on-chain settle feed per asset. Asset stays locked for the duration of a live round (open records it; switching tabs is disabled while live — already the case).

### Operator (`redline3d/scripts/`)
- `bootstrap-devnet.mjs`: after `init_house`/`fund_house`, `init_feed_registry` (if absent) + `set_feed` for the 3 Task-0-verified feeds.
- Redeploy the upgraded program to devnet (program id unchanged — it is upgradeable).

## Data flow

tab picks `asset` → `open(asset, FEEDS[asset], registry)` validates the feed == `registry[asset]` + records `round.asset` → the local engine renders × off that asset's client feed → `crank`/`close`/`flip`/`lever` re-look-up `registry[round.asset]` and require the same feed → settle is feed-relative (`exit/entry`, exponent cancels), so the fixed-point math is unchanged per asset.

## Error handling

- `asset >= MAX_ASSETS` or `!feeds[asset].enabled` → `UnknownAsset` (new) on open.
- passed `price_update` ≠ `registry[asset].feed` → `UntrustedFeed` (existing) — proven by a negative test (open ETH, pass the BTC feed → rejected).
- registry not initialized → open fails on the missing account (operator must bootstrap it first).
- `set_feed` by a non-authority → `has_one = authority` constraint violation.
- All Slice-1/3 gotchas remain (HTTP-poll confirm, ownership-poll delegate, `entryRaw·10^(-expo)`, `.accountsPartial`).

## Testing

- **Task 0a — feed identity:** probe the ER, cross-check the ETH/USD + SOL/USD `feed_id`s against the Lazer feed registry (Lazer indices BTC=1, ETH=2, SOL=6 per the client `ASSETS`); lock the exact account + `feed_id` for each. No wrong-asset risk downstream.
- **Task 0b — registry-in-rollup:** spike that an ER instruction can read the L1 registry account (clone-on-read); else delegate it read-only.
- **Rust unit:** registry lookup, `read_fresh` accepts the matching `feed_id` and rejects a mismatched one, `asset` bounds.
- **Gated devnet integration** (extend `chain-round.devnet.test.ts`): open an **ETH** round → settle on the ETH feed (conserved); a **SOL** round same; **negative** — open ETH but pass the BTC feed account → `UntrustedFeed`; **crank** — a SOL round auto-settles via the crank reading the SOL feed (zero client tx).
- **Claude Preview** on the real game (`index.html`): play a full **SOL** round and a full **ETH** round in the 3D shell (× tracks the chosen asset, settles correctly), per the verify-in-browser rule.

## Decisions / defaults

- **Registry PDA, not hardcoded consts** (user-chosen) — new markets without redeploy; admin (`authority`) is the sole writer = same security as the const pin.
- `asset` = a 1-byte index (0=BTC,1=ETH,2=SOL); `MAX_ASSETS = 8` reserve.
- **One USDC house serves all three assets** (the house holds USDC; settlement is feed-relative; no per-asset house).
- BTC stays asset 0; the program-id and house are unchanged (upgrade in place).
- RMAX=2000 and the settle math are untouched (per-asset identical).

## Risks (all resolved before build commits to them)

1. **Registry-in-rollup read** — Task 0b spike; fallback delegate read-only.
2. **Feed identity** — Task 0a cross-check; a wrong `feed_id` settles the wrong asset.
3. **Redeploy cost** — ~2.7 SOL on a flaky devnet faucet; confirm the deploy keypair's balance before the upgrade (consolidate keypairs if needed, as in Phase 1).

## Carry-forward (not in this slice)

- Per-asset house risk caps / exposure once economics land (Phase 3).
- More markets (DOGE, etc.) — now a `set_feed` call, no redeploy.
- Removing the dead off-chain deposit path from `main.ts` (tracked from Slice 4).
