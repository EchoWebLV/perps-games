# Phase 1 — Core On-Chain Round (Perps Rider) — Design Spec

**Date:** 2026-06-27
**Branch:** `onchain-er-rebuild`
**Builds on:** Phase 0 spike (`spikes/lazer-probe/`, GREEN on devnet) — proved a custom Anchor program delegates to the MagicBlock devnet ER, reads live Pyth Lazer BTC inside the rollup, and commits/undelegates to L1.
**Informed by:** `docs/superpowers/research/2026-06-27-onchain-game-wallet-custody-research.md` (9-agent landscape sweep).

**Two locked drivers everything is judged against:**
1. **Non-custodial** — only the user's own wallet can move their funds out.
2. **Provable fairness** — outcomes decided by a public, externally-attested signed Pyth Lazer price read on-chain; the payout is recomputable by anyone from on-chain data.

---

## Goal

On devnet, prove the full money + settlement loop end-to-end with a real SPL token: **buy-in → delegate to ER → open a round (entry from on-chain Lazer) → close (settle at exit, funds move player⇄house, house provably solvent) → undelegate → withdraw (owner-only).** Driven by a TypeScript test driver (no UI). One asset (BTC).

This is the milestone that makes the *money* on-chain. The settlement math (`@perps/engine`) ports to Rust fixed-point; the existing house/user conserved-settlement model becomes two co-delegated on-chain balance PDAs.

## Scope

**In Phase 1:**
- A new Anchor program `raider` (own Anchor workspace at `onchain/raider/`), reusing the Phase-0 toolchain (anchor 0.32.1 + `ephemeral-rollups-sdk` 0.15.5, built with `~/.avm/bin/anchor-0.32.1`).
- A custom SPL test mint (6 decimals, USDC-shaped) we control, to fund test players + house.
- Program-owned token vault (real USDC custody on L1) + two delegatable u64 balance ledgers: per-player `PlayerBalance` and shared `HouseBalance`.
- `Round` PDA (one open round per player): the open position snapshot.
- Instructions: `init_house`, `buy_in` (create player balance + deposit real USDC → vault), `delegate_session` (co-delegate PlayerBalance + HouseBalance + Round to the ER), `open` (ER), `close` (ER), `force_close` (ER, permissionless + time-bounded), `commit_and_undelegate` (flush to L1), `withdraw` (L1, owner-only).
- **House solvency by construction:** at `open` the program pre-locks `max_payout = floor(stake · CAP · (1 − EDGE))` from `HouseBalance`; if the house can't cover it the round is rejected. The house can never owe more than is already locked.
- **Fixed-point settlement** ported from `@perps/engine` (`equityOf`/`payoutOf`), integer math only (no f64), so the result is deterministic and recomputable.
- **Non-custodial invariant** enforced + tested: `withdraw` re-derives the player PDA from the *signer* and requires the owner as a plain `Signer`; a non-owner withdraw must fail.
- **Liveness backstop:** `force_close` — after `MAX_ROUND_SECS` or on a stale price, *any* signer can settle the round at the current Lazer price and unlock funds (so a stalled validator/abandoned round can never strand funds).
- TS driver running the full loop on devnet with: conservation assert, **provable-fairness recompute assert** (off-chain TS mirror of the fixed-point settle equals the on-chain payout), non-owner-withdraw-rejected assert, and a `force_close` path test.
- `RESULT.md` with verdicts + a **proper latency re-measurement** (research §7.5: nearest validator via Magic Router, `processed` commitment, websocket `accountSubscribe`, p50/p95 from a real geography) to replace the Phase-0 1448ms worst-case datum.

**Deferred (NOT Phase 1):**
- **Session keys** (gpl_session issuance + zero-popup signing) — a *client*-phase concern; Phase 1's driver signs with a local keypair. Phase 1 builds only the **two-authority shape**: `open`/`close` take a `player_authority` the driver sets to the owner; `withdraw` is owner-only. The client phase bolts session keys onto this without reshaping.
- **Wallet front-end** (Wallet Standard / MWA / Seed Vault) — per the approved `docs/superpowers/specs/2026-06-25-privy-removal-wallet-adapter-design.md`. No Privy. Client phase.
- **Intra-round path-dependent liquidation**, **60s game time-cap enforcement**, **flip/lever mid-round actions** — Phase 2 (they need the keeper/mark loop).
- **Pooled/third-party house capital, hedging, crates/VRF, mainnet** — Phase 3/4.
- **Multi-player HouseBalance contention/sharding** — the shared `HouseBalance` is a hot ER account; fine for the single-player Phase-1 driver, sharded later if needed (Phase 3).

## Architecture

```
L1 (Solana devnet)                          Ephemeral Rollup (MagicBlock devnet)
──────────────────                          ────────────────────────────────────
owner wallet ──buy_in──▶ Vault (real USDC)
                         PlayerBalance(u64) ─delegate─▶ PlayerBalance  ┐
                         HouseBalance(u64)  ─delegate─▶ HouseBalance   ├─ open → close
                         Round              ─delegate─▶ Round          ┘   (settle vs Lazer)
owner wallet ◀─withdraw── Vault             ◀─commit_and_undelegate──┘
   (owner-only)
```

Real USDC only moves on L1 (`buy_in`, `withdraw`). All round value movement is cheap u64 arithmetic between the delegated balance ledgers inside the ER. The Lazer BTC feed account is read in-rollup (proven in Phase 0).

## Components

### PDAs
- **Vault authority** — seeds `[b"vault", mint]`. Owns the vault's associated token account (real USDC custody). Never delegated.
- **PlayerBalance** — seeds `[b"player", owner, mint]` → `{ owner: Pubkey, mint: Pubkey, balance: u64, bump }`. Delegatable. The player's in-game balance.
- **HouseBalance** — seeds `[b"house", mint]` → `{ authority: Pubkey, mint: Pubkey, balance: u64, locked: u64, bump }`. Delegatable. `locked` = sum of max-payouts reserved across open rounds.
- **Round** — seeds `[b"round", owner]` → `{ owner, dir: i8, lev: u32, stake: u64, entry_raw: i64, entry_expo: i32, entry_ts: i64, max_payout: u64, deadline_ts: i64, status: u8, bump }`. Delegatable. One open round per player; reused across rounds (status: 0 idle, 1 open, 2 settled).

### Settlement math (fixed-point, ported from `@perps/engine`)
- `SCALE = 1_000_000` (equity in units of 1/SCALE; equity 1.0 = 1_000_000).
- Config (matches `packages/engine/src/config.ts`): `EDGE_FP = 50_000` (0.05), `LIQ_FP = 200_000` (0.2), `CAP_FP = 25_000_000` (25). `RMIN = 10`, `RMAX = 2000` (2000× is non-negotiable).
- Same feed → entry/exit share an exponent, so `ratio_fp = exit_raw · SCALE / entry_raw` (i128).
- `equity_fp = SCALE + dir · lev · (ratio_fp − SCALE)`, clamped `≥ 0` (i128; `dir ∈ {+1,−1}`).
- Terminal precedence at close (single exit mark): `equity_fp ≤ LIQ_FP → liq, payout = 0`; else `equity_fp ≥ CAP_FP → clamp to CAP_FP, outcome = cap`; else `cashout`.
- `payout = floor( stake · equity_fp · (SCALE − EDGE_FP) / SCALE / SCALE )` — **u128 intermediates**, u64 result. (= `stake · equity_fp · 950000 / 1e12`.)
- `max_payout = floor( stake · CAP_FP · (SCALE − EDGE_FP) / SCALE / SCALE )` = `floor(stake · 23.75)` — the house pre-lock at open.

### Money movement (conserved)
- `buy_in`: real USDC `owner → Vault`; `PlayerBalance.balance += amount`.
- `open` (ER): require `PlayerBalance.balance ≥ stake`; `PlayerBalance.balance −= stake`; `max_payout = settle::max_payout(stake)`; require `HouseBalance.balance − HouseBalance.locked ≥ max_payout` (else reject); `HouseBalance.locked += max_payout`; the stake is added to house's effective pot at settle. Store the position in `Round`, `status = open`, `deadline_ts = entry_ts + MAX_ROUND_SECS`.
- `close` (ER): read exit price; `payout = settle(...)`; `PlayerBalance.balance += payout`; `HouseBalance.balance += stake − payout`; `HouseBalance.locked −= max_payout`; `status = settled`. (Conserved: `stake` left player at open, `payout` returns, house nets `stake − payout`; the 5% edge keeps house-favorable.)
- `force_close` (ER): permissionless; require `now_ts ≥ deadline_ts` OR price staleness; settle exactly as `close` at the current Lazer price; unlock.
- `withdraw` (L1): owner `Signer`; `require PlayerBalance.balance ≥ amount`; `PlayerBalance.balance −= amount`; real USDC `Vault → owner` (signed by vault authority PDA seeds).

### Settlement source (provable)
Entry and exit prices are read from the on-chain Pyth Lazer BTC feed account inside the ER (the Phase-0 `parse_price_update` decoder, carried over, **plus** an on-chain staleness check that Phase 0 dropped). The exponent is stored as a **positive magnitude** (USD = price·10^−expo) — Phase-0 finding. The payout is a pure function of `(dir, lev, stake, entry_raw, exit_raw)` + the fixed constants, so anyone can recompute it.

## Error handling
- Reject `open` if a round is already open for the player (`status == open`), if `PlayerBalance.balance < stake`, if `lev ∉ [RMIN, RMAX]`, or if the house's free balance can't cover `max_payout`.
- Reject `close`/`force_close` against a price whose `publish_time` is older than `STALE_SECS` (forces deterministic settlement; `force_close` falls through to deadline handling).
- Reject `withdraw` by a non-owner (the non-custodial invariant) and `withdraw` of more than `PlayerBalance.balance`.
- All balance math uses checked add/sub; on overflow/underflow the instruction errors (no silent wrap).

## Testing strategy
- **Rust unit tests** for the fixed-point settle module against vectors computed from the TS `@perps/engine` (parity within floor rounding).
- **TS driver on devnet** (mirrors the Phase-0 driver) for the end-to-end loop, with the four asserts: conservation, provable-fairness recompute, non-owner-withdraw-rejected, force_close path.
- TDD throughout (test-first per task).

## Open risks (carried, not resolved in Phase 1)
- **ER latency for our case is unmeasured** — Phase 1 *measures* it properly (does not assume <50ms). It is the #1 risk to the "arcade feel" thesis but does not block the money-loop milestone.
- **Validator-stall liveness** — mitigated in-program by `force_close`; confirm the DLP-level forced-exit story with MagicBlock before real money.
- **Legal/licensing** — non-custodial does not settle gambling licensing; real money ships via web/PWA + dApp Store. Separate legal read. Out of Phase-1 scope.

## File structure
```
onchain/raider/
  Anchor.toml                      # toolchain 0.32.1, [programs.devnet] raider, devnet provider
  Cargo.toml                       # workspace
  package.json + tsconfig.json     # ts-mocha driver deps
  programs/raider/
    Cargo.toml                     # anchor-lang 0.32.1 + ephemeral-rollups-sdk 0.15.5 (anchor-compat)
    src/
      lib.rs                       # program: instructions + account contexts
      state.rs                     # PlayerBalance, HouseBalance, Round, constants
      settle.rs                    # fixed-point equity/payout/max_payout + unit tests
      price.rs                     # parse_price_update (carried from spike) + staleness
  tests/
    raider.ts                      # TS end-to-end devnet driver
  RESULT.md                        # verdicts + proper latency re-measurement
```
