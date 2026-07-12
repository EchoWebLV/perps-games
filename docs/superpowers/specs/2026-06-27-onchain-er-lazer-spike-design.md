# Phase 0 Spike — Pyth Lazer Price Inside a MagicBlock Ephemeral Rollup

**Date:** 2026-06-27
**Status:** Approved direction, awaiting spec review
**Type:** Throwaway de-risking spike (not product code)

## Why this exists

We are abandoning the off-chain session-bankroll wallet direction (the
`2026-06-27-session-bankroll-wallet-game-loop-design.md` doc and its private
Postgres ledger) and rebuilding Perps Rider as a **real on-chain game**.

The pivot is driven by exactly two goals — not sponsor narrative, not on-chain
for its own sake:

1. **Provable fairness.** Players must be able to verify the game is honest: the
   price settled against was real, and the payout math is deterministic and
   re-computable by anyone.
2. **Non-custodial funds.** USDC lives in an on-chain program (PDA vaults), moved
   only by program logic — never a server-held treasury keypair.

The chosen architecture is the **full on-chain loop on a MagicBlock Ephemeral
Rollup (ER)** — the same class of system FlashTrade (perp DEX) and Supersize
(real-time game) already run on. The whole round (open → live ticks → liquidation
→ close) executes on the ER at the game's native speed, settled against a
**Pyth Lazer** price feed that MagicBlock refreshes *inside* the rollup
(50–200ms), then state commits back to Solana L1. Off-chain shrinks to a thin
relay + a keeper that posts close/liquidation transactions.

That whole plan rests on one technical assumption that must be seen working
before any real design is committed: **a custom Anchor program can read a live
Pyth Lazer price from inside the ER, and round-trip its state to L1.** This spike
proves (or kills) that assumption on devnet, with throwaway code.

This is **Phase 0** of a 5-phase decomposition (0 spike → 1 core on-chain round →
2 liquidation → 3 economics/house → 4 crates/VRF + mainnet). Each later phase
gets its own spec.

## Goal

Watch, on Solana devnet, a *custom* Anchor program:

1. **Delegate** its own account to the MagicBlock devnet ER (proves delegation
   works for our program, not just MagicBlock's example programs).
2. **Read the live Pyth Lazer BTC/USD price** from inside the ER, fresh — not a
   stale clone.
3. Do so over transactions that are **fast and gasless** — measured, not assumed.
4. **Commit and undelegate** cleanly so the final state lands back on L1.

If all four hold, Phase 1's foundation is proven. If any fail, we learn the real
constraint now — cheaply — before designing the real program.

## Non-Goals (scope guard)

This spike deliberately does **not** include, and the implementation must not add:

- Any USDC / SPL token / vault / deposit / withdraw.
- Any leverage, P&L, payout, or liquidation math.
- Any house account or player-vs-house logic.
- Any client UI — the driver is a script.
- Any product wiring. The code lives in a throwaway directory and may be deleted
  once Phase 1 begins.

Multi-account delegation (two players in one ER session) is **out of scope** here;
it belongs to Phase 1 where the house-vs-player model lives.

## Background facts (verified 2026-06-27)

- **Oracle-in-ER is real.** MagicBlock ingests Pyth Lazer and refreshes ER-resident
  price accounts every 50–200ms (asset-dependent). Source: MagicBlock oracle docs
  and the `magicblock-labs/real-time-pricing-oracle` repo.
- **Read pattern is standard Pyth.** The price account holds a Pyth `PriceUpdateV2`.
  A consumer program takes it as an `AccountInfo`, deserializes via
  `pyth_solana_receiver_sdk`, and reads with `get_price_no_older_than`. Identical
  to reading Pyth on normal Solana — the only difference is the account is being
  refreshed inside the ER.
- **Example feeds already live on devnet.** The MagicBlock devnet cluster already
  serves Pyth Lazer SOL/USD, **BTC/USD**, ETH/USD, USDC/USD example feeds, so the
  spike does **not** need to run its own price pusher — it reads MagicBlock's
  existing BTC/USD feed.
- **Devnet ER endpoints:** RPC `https://devnet.magicblock.app`,
  WebSocket `wss://devnet.magicblock.app`.
- **Delegation lifecycle is Anchor-native:** `ephemeral_rollups_sdk` provides
  `delegate_account()` and `commit_and_undelegate_accounts()`.

## Components

### 1. `lazer-probe` — throwaway Anchor program

A single small program (~100 lines). One PDA account:

```rust
#[account]
pub struct Probe {
    pub last_price: i64,   // most recent Lazer BTC price (raw, Pyth-scaled)
    pub last_expo: i32,    // price exponent
    pub last_ts:   i64,    // publish timestamp of that price
    pub tick_count: u64,   // number of successful samples
    pub bump: u8,
}
```

Instructions:

| Instruction | Layer | Does |
|---|---|---|
| `initialize` | L1 | Create the `Probe` PDA, zeroed. |
| `delegate` | L1 | Delegate `Probe` to the devnet ER via `ephemeral_rollups_sdk` (owner → delegation program). |
| `sample` | ER | Read the Lazer BTC/USD price account (`AccountInfo`), validate freshness with `get_price_no_older_than`, write `last_price`/`last_expo`/`last_ts`, bump `tick_count`. |
| `commit_and_undelegate` | ER → L1 | `commit_and_undelegate_accounts` to checkpoint and release `Probe` back to L1. |

### 2. `driver.ts` — orchestration + measurement script

Drives the full lifecycle against devnet + the ER endpoint:

1. `initialize` the Probe on L1.
2. `delegate` it; confirm owner flipped to the delegation program.
3. Fire **≥50 `sample` transactions** on the ER in a loop, recording per-tx
   round-trip latency.
4. Read the Probe back from the ER; log `last_price` / `last_ts` / `tick_count`.
5. `commit_and_undelegate`.
6. Read the Probe from L1; confirm the final sampled price persisted and the owner
   returned to our program.

### 3. Ground-truth cross-check

Reuse the existing off-chain Lazer client (`feed.js`) to pull the live BTC/USD
price during the run and assert the on-chain `Probe.last_price` matches within a
small tolerance. This is what proves the ER price is *real and live*, not a frozen
or fabricated value.

## Flow

```
L1:  initialize Probe ─► delegate Probe to ER (owner → delegation program)
ER:  loop sample × N  ─► Probe.last_price tracks live Lazer BTC, last_ts advances,
                          per-tx round-trip latency measured
ER:  commit_and_undelegate
L1:  read Probe ─► final sampled price persisted, owner back to lazer-probe program
```

## Success criteria (all measurable, pass/fail)

1. **Delegation:** Probe is created on devnet L1 and successfully delegated to the
   ER (owner becomes the delegation program). PASS/FAIL.
2. **Latency:** ≥50 `sample` txs land on the ER; the **median round-trip latency is
   recorded** and is well under ~150ms. PASS/FAIL (record the number regardless).
3. **Liveness + correctness:** `Probe.last_price` matches the live off-chain Lazer
   BTC price within tolerance, **and `last_ts` advances across samples** (proves a
   live feed, not a static clone). PASS/FAIL.
4. **Round-trip:** After `commit_and_undelegate`, the Probe is back on L1 with the
   final sampled price intact and owner returned to our program. PASS/FAIL.

A written result (the four verdicts + the measured latency + any surprises) is the
deliverable. Green on all four ⇒ Phase 1 design proceeds. Any red ⇒ we redesign
around the real constraint before spending Phase 1 effort.

## Unknowns this spike will surface

These are expected discoveries, not blockers — surfacing them is part of the point:

- Exact devnet Pyth Lazer **BTC/USD feed pubkey**, and whether reads require auth
  headers / an API key.
- Whether deploying a **custom** program to the devnet ER needs any MagicBlock
  registration or whitelisting (the examples suggest not).
- Real **latency and cost** vs. the published 50–200ms / sub-50ms figures.
- ER RPC quirks: how `sample` txs are submitted/confirmed against the ER endpoint
  vs. base-layer devnet, and any SDK version pinning needed (validator v0.8.8).

## Dependencies & setup

- Rust + Anchor toolchain; `ephemeral_rollups_sdk`; `pyth_solana_receiver_sdk`.
- A funded devnet keypair.
- MagicBlock devnet ER endpoints (`https://devnet.magicblock.app`,
  `wss://devnet.magicblock.app`).
- The existing off-chain Lazer client (`feed.js`) for the ground-truth cross-check.

## How this feeds Phase 1

Phase 1 (core on-chain round) reuses the proven pieces directly: the same delegate
→ act-on-ER → commit/undelegate lifecycle, the same Pyth Lazer read pattern for
entry/mark/exit pricing, and the measured latency budget. The `Probe` account
becomes the seed of the real `Round` account; `sample` becomes `open`/`close`. If
the spike is green, Phase 1 is an extension, not a leap.
