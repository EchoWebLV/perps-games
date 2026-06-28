# Phase 2 — Continuous Settlement + Mid-Round Actions (Perps Raider) — Design Spec

**Date:** 2026-06-28
**Branch:** `onchain-er-rebuild`
**Builds on:** Phase 1 (`onchain/raider/`, GREEN + verified on devnet) — the full money loop buy-in → delegate → open → close → undelegate → owner-only-withdraw, settled against the on-chain Pyth Lazer BTC feed, with the hardened feed-auth path (`#[account(address = BTC_FEED)]` + owner + feed_id + staleness in `read_fresh`).
**Informed by:** `docs/superpowers/research/2026-06-27-onchain-game-wallet-custody-research.md`, the 2026-06-28 Phase-2 research workflow (MagicBlock crank/keeper + perp-liquidation landscape), and a direct read of the current off-chain game rules (`packages/engine/src/{config,settle,economics}.ts`, `redline3d/src/`, `server/src/services/rounds.ts`).

**Two locked drivers everything is judged against (unchanged):**
1. **Non-custodial** — only the user's own wallet can move their funds out.
2. **Provable fairness** — every outcome is decided by a public, externally-attested Pyth Lazer price read on-chain; the payout is recomputable by anyone from on-chain data.

---

## Goal

On devnet, make the round a **live, continuously-settled state machine**: a position can be **liquidated or capped the moment an on-chain-observed price crosses the threshold mid-round** (not only at close), auto-closes at a **60-second time-cap**, and supports **flip** (reverse direction) and **lever** (change leverage) mid-round — all settled against the on-chain Lazer feed and recomputable by anyone. Driven by a TypeScript driver (no UI) that includes a **house keeper tick-loop**, with a parallel **`crank-probe` spike** to confirm whether the devnet ER validator can drive the tick natively.

This adds the **path-dependence** the off-chain engine explicitly deferred (`settle.ts:58` — "continuous per-tick liquidation is the deferred autonomous settler's job") onto the now-hardened Phase-1 feed-read + settlement machinery.

## Scope

**In Phase 2:**
- **`Round` becomes mutable mid-round:** add `banked: i128` (fixed-point realized P&L, signed); `dir`, `lev`, `entry_raw` become mutable. `Round::SIZE` 116 → 132 (+16 for the i128).
- **`settle.rs`:** add `rebank_fp(...)` and thread `banked` through `equity_fp(...)`; integer math only, parity-tested against the off-chain engine via a **BigInt mirror** (the IEEE-754 off-by-one lesson — never the float engine).
- **`tick` (new, permissionless):** the continuous settler / auto-close. Reads the authenticated Lazer price, computes equity, applies terminal precedence **liq → cap → time**, and on any terminal does the money movement (player += payout, house += stake − payout, house.locked −= max_payout, status = settled) + emits an event. No-op heartbeat otherwise.
- **`flip(new_dir)` + `lever(new_lev)` (new, owner-authority):** check terminal at the current authenticated price *first* (settle if already terminal), else `rebank` and change `dir`/`lev`. `lever` validates `new_lev ∈ [RMIN, RMAX]`.
- **`open` / `close` / `force_close` updated:** `open` initializes `banked = 0` and `deadline_ts = entry_ts + MAX_ROUND_SECS` (now **60s**, the game cap); `close` and `force_close` thread `banked` and the **time** terminal.
- **Provable-fairness trail:** an Anchor `emit!` event on every transition (`open` / `flip` / `lever` / terminal) carrying `{ kind, price_raw, ts, banked_after, dir, lev, equity_fp }`. Final committed `Round` + the event stream = the full reconstructable path.
- **Trigger — hybrid (keeper-first, crank-ready):** the TS driver runs a permissionless **house keeper loop** (~150–250ms) calling `tick`. A separate **`spikes/crank-probe/`** confirms whether the devnet ER validator `MAS1Dt9…` honors `MagicBlockInstruction::ScheduleTask`. **If the spike is GREEN**, add `schedule_tick` (CPI `ScheduleTask` at open) + `cancel_tick` (CPI `CancelTask` at settle) — the on-chain `tick` ix is byte-identical, only the trigger swaps.
- **Devnet driver tests:** continuous 2000× liquidation, auto cap-out, 60s time-cap settle, flip parity vs `settleRound`, lever parity, race guard (flip/lever after settle rejected), force_close backstop, conservation + non-custodial invariants carried forward. Rust unit parity tests for `rebank_fp` / banked-`equity_fp`.
- **`RESULT.md` updated:** continuous-tick latency (per-tick warm p50/p95), the `crank-probe` verdict, and the carried Phase-1 verdicts.

**Deferred (NOT Phase 2):**
- **Session keys / zero-popup signing** — client phase. `flip`/`lever` use the **owner-authority** shape (driver signs with the owner keypair); the client bolts session keys onto this without reshaping.
- **Wallet front-end** (Wallet Standard / MWA / Seed Vault) — client phase.
- **Per-player upgrade-gated leverage caps** — leverage rises from a 1000 base to the 2000 ceiling via the **soft-coin economy upgrades**; that per-player gate lives in the **economy/authorization layer**, not the core round program. The program enforces only the **hard ceiling `RMAX = 2000`**.
- **One shared crank scanning many rounds** — Phase 2 is one keeper/crank per the single-player round; a shared scanner is a Phase-3 scaling concern.
- **Pooled/third-party house capital, hedging, crates/VRF, mainnet** — Phase 3/4.
- **Multi-player HouseBalance contention/sharding** — Phase 3.

## Architecture

```
Ephemeral Rollup (MagicBlock devnet) — the round is LIVE here
────────────────────────────────────────────────────────────
   open ──▶ Round{ banked, dir, lev, entry_raw, ... status=open }
                │
                ├── flip(new_dir)   ─┐  terminal-first, then rebank + mutate
                ├── lever(new_lev)  ─┘  (owner-authority)
                │
   keeper/crank ──▶ tick ──▶ read authenticated Lazer price
                │            equity = SCALE + banked + dir·lev·(ratio−SCALE)
                │            liq? cap? time(≥60s)?  ──▶ settle + money move + event
                ▼
   settle ──▶ status=settled ──▶ (Phase-1) commit_and_undelegate ──▶ L1 ──▶ owner-only withdraw
```

The trigger (keeper, crank, or any stranger) only ever calls `tick`; **the program reads the price and renders the verdict**, so the trigger can never choose an outcome. Real USDC still moves only on L1 (`buy_in` / `withdraw`, both from Phase 1). All round value movement remains cheap u64/i128 arithmetic between the delegated balance ledgers inside the ER.

## Components

### `Round` state (`state.rs`)
Phase-1 fields unchanged, **plus**:
- `banked: i128` — realized P&L accumulator in SCALE units (e.g. `+0.1` → `100_000`), signed. Initialized to `0` at `open`.

`dir: i8`, `lev: u32`, `entry_raw: i64` are now **mutated** by `flip` / `lever`. `Round::SIZE` 116 → **132**.

### Settlement math (`settle.rs`, fixed-point — extends Phase 1)
Constants unchanged: `SCALE = 1_000_000`, `EDGE_FP = 50_000`, `LIQ_FP = 200_000`, `CAP_FP = 25_000_000`, `RMIN = 10`, `RMAX = 2000`. **`MAX_ROUND_SECS` 300 → 60** (8 under `test-short-deadline`), `STALE_SECS = 30`.

- `ratio_fp(entry_raw, price_raw) = price_raw · SCALE / entry_raw` (i128).
- `segment_fp(dir, lev, entry_raw, price_raw) = dir · lev · (ratio_fp − SCALE)` (i128, SCALE units).
- **`equity_fp(banked_fp, dir, lev, entry_raw, price_raw) = SCALE + banked_fp + segment_fp`**, clamped `≥ 0` (i128). (Integer port of off-chain `equityOf`: `1 + banked + dir·lev·(price/entry − 1)`.)
- **`rebank_fp(banked_fp, dir, lev, entry_raw, price_raw) = banked_fp + segment_fp`** (i128). (Integer port of off-chain `rebank`.) After `rebank`, `entry_raw = price_raw`, then `dir`/`lev` change.
- `terminal(equity_fp)` — precedence **liq → cap → cashout**: `equity ≤ LIQ_FP → (Liq, 0)`; else `equity ≥ CAP_FP → (Cap, CAP_FP)`; else `(Cashout, equity)`. The `Outcome` enum (Phase 1: `{ Cashout, Cap, Liq }`) gains a **`Time`** variant.
- `payout(stake, settled_eq_fp) = floor(stake · settled_eq_fp · (SCALE − EDGE_FP) / SCALE / SCALE)` — u128 intermediates, u64 result (unchanged from Phase 1).
- `max_payout(stake) = payout(stake, CAP_FP) = floor(stake · 23.75)` (unchanged).

**House-solvency invariant survives flip/lever:** `terminal` clamps total equity to `CAP_FP` at settle, so for *any* `banked`, `payout ≤ payout(stake, CAP_FP) = max_payout`. The Phase-1 pre-lock of `max_payout` at `open` therefore still covers the worst case — banking profit across segments can never make the house owe more than it already locked.

### Time terminal (the 60s game-cap)
Full per-instruction precedence is **liq → cap → time → (no-op for `tick` / cashout for `close`)**: compute `equity_fp`, run `terminal()` (liq/cap), and if it returns `Cashout`, then check `now_ts ≥ entry_ts + MAX_ROUND_SECS → (Time, equity)` — settle at the current (un-clamped-beyond-cap) equity, matching off-chain `settle.ts:65-71`. Evaluated inside `tick`, `close`, and `force_close`. `force_close` is only callable once `now ≥ deadline_ts`, so liq/cap/time always fires there; `tick` no-ops when none fire; `close` cashes out when none fire (owner closing early).

### Instructions
- **`tick` (new, permissionless):** accounts = `[ Round (open), PlayerBalance, HouseBalance, price_update #[account(address = BTC_FEED)] ]` + a fee payer. Reads `read_fresh` price; `eq = equity_fp(round.banked, round.dir, round.lev, round.entry_raw, exit_raw)`; if `terminal`/time fires → settle (compute `payout`, `player.balance += payout`, `house.balance += stake − payout`, `house.locked −= max_payout`, write `exit_raw`/`exit_ts`/`payout`/`outcome`, `status = settled`, `emit!`). Else no-op. **No user signature** (crank-compatible: validator-signed).
- **`flip(new_dir: i8)` (new, owner-authority):** require `status == open`, `new_dir ∈ {+1,−1}`, `now < deadline_ts`. Read `read_fresh` price. **Terminal-first:** if `terminal(equity_fp(..)) ` or time fires → settle exactly as `tick`. Else `round.banked = rebank_fp(..)`, `round.entry_raw = price`, `round.dir = new_dir`; `emit!`.
- **`lever(new_lev: u32)` (new, owner-authority):** identical to `flip` but require `new_lev ∈ [RMIN, RMAX]` and set `round.lev = new_lev` (not `dir`).
- **`open` (modified):** init `banked = 0`; `deadline_ts = entry_ts + MAX_ROUND_SECS` (60s). All Phase-1 checks (player balance ≥ stake, lev ∈ range, house free balance ≥ max_payout pre-lock) unchanged.
- **`close` (modified):** thread `banked` into `equity_fp`; add the time terminal; otherwise the Phase-1 owner-initiated cashout.
- **`force_close` (modified):** permissionless, `now ≥ deadline_ts` (now 60s) or stale price; thread `banked`; settle as `tick`.
- **`schedule_tick` / `cancel_tick` (new, conditional on crank-probe GREEN):** CPI `MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs{ task_id, execution_interval_millis, iterations, instructions: vec![tick_ix] })` to `MAGIC_PROGRAM_ID` at `open`; `CancelTask{ task_id }` at settle. Validator-signed execution — compatible because `tick` needs no user signature.

Authority shape (carried from Phase 1): `flip`/`lever`/`close`/`withdraw` take/are gated by a `player_authority` set to the **owner**; `tick`/`force_close` are permissionless. Session keys (client phase) later narrow `player_authority` to a scoped key without reshaping.

### Trigger (hybrid)
- **Keeper (launch path):** a TS loop subscribed to the ER, calling `tick` every ~150–250ms while a round is open; stops on terminal. Permissionless and **no bounty** — the house is the economic beneficiary of every liquidation (payout 0), so it has every reason to run the keeper; a bounty would only leak edge. In the driver, the keeper is an in-process loop.
- **Crank (upgrade path):** `spikes/crank-probe/` schedules a trivial self-incrementing task via `ScheduleTask` against validator `MAS1Dt9…`; if it auto-fires, wire `schedule_tick`/`cancel_tick` and retire the keeper. Measures min `execution_interval_millis`, max `iterations`, and who pays per-iteration.

### Provable-fairness trail
`emit!` per transition with `{ kind, price_raw, ts, banked_after, dir, lev, equity_fp }`. Because every price the program acts on is `read_fresh`-authenticated and address-pinned, the committed final `Round` + the event stream let anyone reconstruct and re-verify the entire path. No Merkle/hash commitment (over-build for devnet).

## Error handling
- `tick`: reject against a stale/forged price (carried Phase-1 `UntrustedFeed`/`StalePrice`); no-op (not error) when no terminal fires; reject if `status != open` (idempotency — a settled round can't be re-settled).
- `flip`/`lever`: reject if `status != open`, if `now ≥ deadline_ts`, if `new_dir ∉ {+1,−1}` / `new_lev ∉ [RMIN, RMAX]`, or against a stale/forged price. **Terminal-first** means a flip/lever submitted at an already-liquidating price settles liq rather than escaping it (matches off-chain `terminalAt`-before-`applyAction`).
- **Race guard:** `flip`/`lever` racing a `tick` that already settled are rejected by the `status == open` check — slot order is canonical.
- All `banked`/balance math uses checked/i128 arithmetic; overflow/underflow errors (no silent wrap). `overflow-checks = true` already set.

## Testing strategy
- **Rust unit tests (`settle.rs`):** `rebank_fp` and banked-threaded `equity_fp` against BigInt vectors mirroring `economics.ts`; flip and lever sequences (open → action → exit) parity; terminal precedence with non-zero `banked`; the solvency bound (`payout ≤ max_payout` for large `banked`).
- **TS devnet driver:**
  - **Continuous liquidation:** open 2000×, run the keeper loop, assert liq fires within ~1–2 ticks of the crossing, payout 0, lock released, conserved.
  - **Auto cap-out:** open a direction that caps, assert a `tick` settles `cap` with `payout == max_payout`.
  - **60s time-cap:** open, run to the cap (via `test-short-deadline`), assert a `tick` settles `time` at current equity.
  - **Flip parity:** open long → `flip` short mid-round → `close`; assert on-chain payout == off-chain `settleRound` over the same `{open, flip@price, exit}`.
  - **Lever parity:** open 100× → `lever` 500× mid-round → `close`; parity assert.
  - **Race guard:** `flip` after a settling `tick` is rejected.
  - **force_close backstop:** after deadline with the keeper stopped, permissionless `force_close` settles + unlocks.
  - Conservation + non-owner-withdraw-rejected invariants carried forward.
- **`crank-probe` spike:** separate green/red gate; does not block the keeper path.
- TDD throughout (test-first per task).

## Open risks (carried / new)
- **Crank availability on our validator** — the one real unknown; de-risked by `crank-probe`, with the keeper as the proven fallback. The design does not depend on the crank.
- **Crank min-interval / iteration-cap / per-iteration fee** — unknown until the spike measures them; affects only the crank upgrade path.
- **Tick cadence vs 2000× granularity** — at 2000× a ~0.05% move liquidates; Lazer pushes every 50–200ms and the keeper ticks ~150–250ms, so liq fires within ~1–2 ticks. The observed-only model is provably correct at any cadence (faster = tighter to "true" liquidation).
- **Missed-tick asymmetry** — if the trigger stalls and price dips below LIQ then recovers between observed ticks, no liq fires (**house eats the miss**, player-favorable); bounded by cadence + the 60s force_close. Only on-chain-observed prices count — that is the provable truth.
- **ER latency for the tick loop** — measured in `RESULT.md`; the #1 risk to "arcade feel" but not to the settlement-correctness milestone.
- **Legal/licensing** — unchanged from Phase 1; out of scope.

## File structure
```
onchain/raider/
  programs/raider/src/
    lib.rs        # + tick, flip, lever; open/close/force_close updated; (cond) schedule_tick/cancel_tick
    state.rs      # Round + banked: i128; SIZE 116 → 132; MAX_ROUND_SECS 300 → 60
    settle.rs     # + rebank_fp; banked threaded through equity_fp; + unit tests
    price.rs      # unchanged (hardened read_fresh carried from Phase 1)
  tests/
    tick-liq.ts        # continuous 2000× liquidation via keeper loop
    tick-cap.ts        # auto cap-out
    timecap.ts         # 60s time terminal
    flip.ts            # flip parity vs settleRound
    lever.ts           # lever parity vs settleRound
    raceguard.ts       # flip/lever after settle rejected
    (raider.ts / forceclose.ts / feedauth.ts / liq.ts / gates.ts carried from Phase 1)
  RESULT.md            # + continuous-tick latency + crank-probe verdict
spikes/crank-probe/    # ScheduleTask availability probe on devnet ER validator
```
