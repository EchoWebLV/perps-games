# House Sharding — Single Pot + Auto Per-Session Slices

**Date:** 2026-06-30
**Branch:** `onchain-er-rebuild`
**Status:** Design approved (brainstorming), ready for implementation plan.

## Goal

Let many players have an on-chain ER round open **at the same time**, funded from a
**single bankroll**, with no manual per-player funding. Today the `HouseBalance` PDA is
a singleton per mint (`[b"house", mint]`) that gets co-delegated to the rollup for every
round, so only one session can hold it at a time — the one-at-a-time bottleneck and the
main devnet iteration friction.

**Player experience is unchanged.** Car, road, throttle, LONG/SHORT, GO, cash-out, 2000×,
wSOL/SOL custody, crank, feeds, Privy/dev-keypair wallets — all untouched. Pure
money-plumbing.

## The hard constraint that shapes the design

A round settles **inside the MagicBlock ER**. The ER can only mutate accounts that are
**delegated** to that session, and **a given account can be delegated to only one ER
session at a time.** Therefore the single shared pot cannot be delegated to many
concurrent sessions — that is exactly today's contention. Each concurrent round needs its
own delegated account holding enough to cover its worst-case payout.

## Decision (locked) — single pot, automatic per-session slices

Keep **one bankroll** and slice it automatically:

- **Master pot** = the existing singleton `[b"house", mint]` (`HouseBalance`), repurposed as
  the operator's single bankroll. **Never delegated.** Funded once via `fund_house`
  (e.g. 10 SOL). Lives on L1.
- **Per-session till** = a per-player PDA `[b"house", mint, owner]` (same `HouseBalance`
  layout). When a player starts a session the program **moves one worst-case payout off the
  master pot into their till** (L1, before delegation), then co-delegates the till with the
  player's already-per-player Player + Round accounts. The round settles against the *till*
  inside the ER. When the session ends, the program **sweeps the till's leftover back to the
  master pot** (L1).

Result: one funded pot; the program cuts an ephemeral slice per active session and returns
it (minus winnings) when the session ends. **Losses flow straight back to the pot for the
next player (self-smoothing).** Concurrency is capped only by `master.balance ÷ slice`, and
when `master.balance < slice` no new session can start — the operator's "pot under threshold
→ not playable" rule, enforced on-chain.

### Slice size — sized to the player's bet, not the max

The slice is `max_payout(stake)` for the player's **selected play amount at session start**,
NOT a fixed max-bet constant. `max_payout(stake) = stake × 23.75` (CAP 25 × edge 0.95):

| stake | slice locked | concurrent sessions on a 10 SOL pot |
|---|---|---|
| 0.01 SOL (min) | ~0.2375 SOL | ~42 |
| 0.05 SOL | ~1.1875 SOL | ~8 |
| 0.10 SOL (max) | 2.375 SOL | ~4 |

So small-bet players barely touch the pot and concurrency scales accordingly; a 10 SOL pot
holds dozens of min-bet games at once. The lock is **exactly the worst-case payout for the
bet placed** (so the winner is always payable — provable solvency) and **nothing more**.

**No new bet cap is introduced.** The existing open-time coverage check
(`till.balance − till.locked ≥ max_payout(stake)`) is what guarantees solvency; the slice
just front-loads enough for the session's chosen stake. If a player **raises** their bet
mid-session above what the slice covers, `open` is rejected and they End + GO to re-slice a
larger amount (the till can't be topped up while delegated). Betting the same or smaller is
always fine. The single lever that would shrink the lock for a *given* bet is lowering the
25× max-win cap — explicitly **not** changed (it would reduce player upside).

### Why per-session (not per-round)

The master pull/sweep happens **once per delegated session** (at delegate / at
undelegate), not per round. Within a session the till is the "house" for all that session's
rounds, cycling wins/losses locally — identical to today's settle math, just against the
till. (A rare hot streak can drain a till below a round's `max_payout` mid-session →
`open` is rejected; the player ends + restarts to re-slice from the pot. Acceptable edge.)

### Alternatives rejected

- **Fixed pool of N pre-seeded counters:** caps concurrency at N, needs a client
  lane-picker + race-retry + "tables full" UI, and isn't self-smoothing. Rejected.
- **Manually pre-funded per-player houses:** no auto take/return; operator must fund every
  player and money is reserved even when idle. Rejected (this was the earlier draft; the
  single-pot auto-slice supersedes it).

## Key facts grounding the design

- **Max payout is bounded at 23.75× stake** (`max_payout = payout(stake, CAP_FP)`, CAP 25 ×
  edge 0.95). At the 0.1-SOL max bet that's **2.375 SOL** per in-flight session.
- **One shared vault token account per mint** (`[b"vault", mint]` authority PDA's ATA)
  custodies all real tokens. `house.balance` (master and tills) and `player.balance` are u64
  accounting ledgers against that single vault. The master↔till and house↔player moves are
  **accounting transfers**; real tokens never leave the vault until a player `withdraw`s.
  Invariant: `master.balance + Σ till.balance + Σ player.balance ≤ vault token balance`.
- **Current settle money flow** (unchanged math, now against the till):
  - `open` (ER): `player.balance -= stake`; `house.locked += max_payout`.
  - settle (ER): `player.balance += payout`; `house.balance += stake - payout`;
    `house.locked -= max_payout`. Conserved across player + house; edge stays house-side.
- **`fund_house(amount)` is permissionless** (transfers real tokens funder→vault, credits
  `house.balance`) — used to stack the master pot.

## Components / changes

### 1. Program (`onchain/raider/programs/raider/src/`)

The house seed gains `owner` for the **till**; the **master** keeps `[b"house", mint]`.
`owner` is already a seed of Player/Round and in scope everywhere (signer, or `round.owner`
in permissionless paths), so **no new per-round instruction args** and **no `Round` field /
no `Round::SIZE` change** (so no post-upgrade fresh-wallet migration).

- **`state.rs`** — doc only: `HouseBalance` now serves both the master pot (`[house,mint]`)
  and per-session tills (`[house,mint,owner]`); layout/`SIZE` unchanged.
- **`lib.rs`**:
  - **New `slice_from_pot(slice)` (L1, pre-delegate):** `slice = max_payout(selected_stake)`
    passed by the client. Move `slice` master→till (`require!(master.balance >= slice)` else
    `HouseUndercapitalized`; `master.balance -= slice`; init/credit `till.balance += slice`;
    `till.authority = master.authority`). Replaces funding the house before delegation.
    Context carries master house (`[house,mint]`), till (`[house,mint,owner]`), and `owner`.
  - **`DelegateSession`** — delegate **till** (`[house,mint,owner]`) + Player + Round.
    The master is **not** in this context.
  - **`open` / `Close` / `Flip` / `Lever` / `Tick` / `ForceClose` / `ScheduleTick` /
    `TickCrank`** — the `house` account becomes the **till** (`seeds=[HOUSE_SEED, mint, owner]`,
    `owner` = signer or `round.owner`). Settle math is **unchanged**.
  - **`commit_and_undelegate` (`SessionCommit`):** commits Player+**Till**+Round to L1 and
    undelegates them (house seed → till). It does **not** itself sweep: this instruction runs
    **inside the ER**, where the master pot (L1-only, never delegated) is unreachable and
    undelegation is async, so the master can't be mutated here.
  - **New `sweep_till()` (L1, permissionless, post-undelegate):** the actual sweep —
    `master.balance += till.balance; till.balance = 0` (requires `till.locked == 0`). Called by
    the client right after `commit_and_undelegate` lands, and reusable by a keeper to reclaim an
    abandoned session's slice. Permissionless because returning a till to the pot can only
    consolidate value in, never extract it. Till is kept at 0 for reuse (rent retained).
    `slice_from_pot` also folds any unswept leftover back before re-slicing (self-healing), so a
    skipped sweep can never double-spend.
  - **`fund_house`** — unchanged; stacks the **master** pot.
  - **`init_house`** — unchanged shape; used to create the master pot (operator-signed).
- **`settle.rs` / `price.rs`** — unchanged.

`owner` provenance: operator-driven setup signs `fund_house`/`init_house` for the **master**
(`owner` not involved). Player-driven play (`slice_from_pot`, `DelegateSession`, `open`,
`Close`, `Flip`, `Lever`, `SessionCommit`) uses the **signer** as `owner`. Permissionless
(`Tick`, `ForceClose`, `ScheduleTick`, `TickCrank`) uses **`round.owner`**.

### 2. Client (`redline3d/src/chain/`)

- **`chain-round.ts` `derivePdas()`** — add the per-session till
  (`[b"house", mint, owner]`); keep the master (`[b"house", mint]`) for the slice/sweep
  contexts. All settle calls target the till.
- **Session start (`ensureSession` / `delegate`)** — call `slice_from_pot` (L1) before
  `delegate_session`; surface `HouseUndercapitalized` as "Tables are full right now — the
  bankroll is fully in play, try again in a moment."
- **Session end (`commitAndUndelegate` then `sweepTill`)** — after the undelegate lands,
  the client calls the permissionless L1 `sweep_till` to return the till to the master pot.
- **`classifyDelegateState` / `DelegateBusyError`** — the per-session till can never be held
  by a *foreign* wallet, so the cross-player "busy" case disappears; only the player's own
  stale-but-live session remains ("reuse"). Keep as a safety net; update doc comment.
- **No lane-picker / race-retry / per-player manual funding UI.**
- **`game-session.ts` / `main.ts`** — minimal; the till is internal to `derivePdas`. New
  surfaced statuses: bankroll-full (above) and the rare mid-session "till drained, end &
  restart."

### 3. Scripts (`redline3d/scripts/`)

- **`bootstrap-devnet.mjs`** — set up shared infra once: mint, vault, feed registry, and the
  **master pot** (`init_house` + `fund_house` with the bankroll, e.g. 10 SOL).
- **`fund-wallet.mjs <addr> <sol>`** — funds **native SOL only** to a test wallet (so it can
  wrap + buy in). It no longer needs to fund a per-player house — the master pot auto-slices
  at session start.

## Data flow (one session)

1. **Setup (operator, once):** `init_house` + `fund_house(10 SOL)` on the master `[house,mint]`.
2. **Session start (player):** `buy_in` (wrap SOL→vault, credit player.balance) →
   `init_round` if needed → **`slice_from_pot(slice)`** where `slice =
   max_payout(selected_stake)` (L1: master −slice → till +slice, gated on master ≥ slice) →
   `delegate_session` (Player + **Till** + Round → ER).
3. **Play (ER):** open / flip / lever / tick / crank settle against the **till** — no other
   session touches it.
4. **Settle (ER):** `player.balance += payout`; `till.balance += stake − payout`;
   `till.locked −= max_payout`.
5. **End:** `commit_and_undelegate` commits Player+Till+Round to L1; then a separate L1
   `sweep_till` does `master.balance += till.balance` (it can't be done inside the ER commit —
   the master is L1-only). The next player's slice can now draw on it.
6. **Withdraw:** player.balance → real SOL (unwrap), unchanged.

Two players running 2–5 simultaneously touch disjoint delegated accounts (their own
Player+Till+Round); the master is touched only by brief L1 writes at slice/sweep → true
concurrency.

## Error handling

- **Bankroll can't cover the slice** (`master.balance < slice` at `slice_from_pot`): reject
  with "Tables are full right now, try again in a moment." On devnet, `fund_house` more.
- **Till drained mid-session** by a hot streak (`till free < round max_payout` at `open`):
  "End your session and press GO to start a fresh one." (Re-slices from the pot.)
- **Abandoned session:** ties up only its 2.375 slice (not the whole pot, unlike today). The
  existing `force_close` settles it; a permissionless/keeper undelegate-and-sweep reclaims
  the slice (reclaim path detailed in the plan).
- **Stale own session:** `classifyDelegateState` "reuse" path skips delegate — unchanged.

## Economics / operational notes (per build-only-what's-asked: surfaced, not over-built)

- **Concurrency cap = `master.balance ÷ slice`**, where `slice` scales with each player's
  bet (~0.24 SOL for a min bet, 2.375 SOL for a max bet) — so a 10 SOL pot holds dozens of
  small-bet games or ~4 max-bet games. The true economic limit, enforced on-chain, not an
  artificial code cap. This *is* the operator's requested behavior.
- **Self-smoothing:** losses sweep back to the master pot at session end, funding the next
  player — the single-bankroll property the operator wants. No per-player capital reserved
  when idle.
- **No auto-balancer, max-stake schedule, throttle, or extra cap is built** beyond the
  pot-threshold gate the operator explicitly specified.
- **Old behavior:** the singleton `[house,mint]` is *kept* (now the master pot), not
  abandoned — a clean conceptual reuse.

## Testing

- **Rust unit:** master vs till derive distinct PDAs (`[house,mint]` vs `[house,mint,owner]`);
  `slice_from_pot` conserves (`master + till` constant); sweep restores; settle conservation
  holds against the till; `slice_from_pot` rejects when `master.balance < TILL_FILL`.
- **Gated devnet (headline):** two funded wallets each `slice_from_pot` + open rounds
  **concurrently** (neither gets `delegate_busy`), each settles, each sweeps back; the master
  pot's net change equals the summed player P&L (conservation across the pot). Single-player
  loop no-regression. A third session rejected when the pot can't cover another slice.
- **Claude Preview (per [[verify-ui-in-browser-before-done]]):** the real game plays
  end-to-end on a funded dev keypair (GO → crank settle → End → Withdraw); the slice/sweep is
  invisible to the UI.

## Out of scope (deferred)

- Auto-balancer keeper (only relevant once you want headroom management beyond the simple
  threshold gate).
- Single-account escrow variants / mainnet capital tuning.
- Mainnet cutover, USDC, fiat on-ramp.
- Privy zero-popup manual pass (separate track).

## References

[[onchain-er-rebuild]] · [[build-only-what-asked-no-risk-scaffolding]] ·
[[leverage-2000x-non-negotiable]] · [[verify-ui-in-browser-before-done]]
