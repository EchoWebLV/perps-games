# On-chain race book — design

2026-07-27. Approved via brainstorm Q&A. Moves race **betting and settlement** into a
MagicBlock Ephemeral Rollup as shared, multi-writer state, and takes the race outcome
away from the player's browser. The race *simulation* deliberately stays client-side.

New Anchor program: **`paddock`**. Separate from `raider`, same wSOL mint, devnet first.

## Why this split

The race sim is not a simulation. `calibrateBase()` (`redline3d/src/render/race-mode.ts:312`)
back-solves each car's speed from a finish order chosen in advance, so putting 8,640
float64 substeps × 8 cars on-chain would pay a validator to compute an answer that already
exists — and would force bit-exact agreement between Rust and JS across `Float32Array`
cornering interpolation and a 3000-division Catmull-Rom arc length.

What genuinely needs the rollup is the **betting market**: sub-second, gas-free writes
into a shared pari-mutuel pool during a 15-second window, with odds moving as other
players' bets land. That is not possible on L1, and unlike the perps round it is
inherently multiplayer.

**Chain owns the result. Client owns the show.**

## Decisions (user-approved)

- **Shared pool, many players.** Real pari-mutuel against other bettors, not fixed odds
  against the house. This is what makes "in the ER" load-bearing rather than decorative.
- **Continuous house races, bet-only.** Exactly one live race at a time, 8 house cars,
  cycling back-to-back on a crank-driven clock. Everyone bets the same race.
- **Owner podium payout stays inert.** `OWNER_POOL_SHARE = 0.4` in
  `redline3d/src/core/race-payout.ts` remains defined but unused — there are no
  player-owned entrants in the bet-only cut. It reactivates untouched when player-entered
  heats land. This cut is a strict subset of that model; nothing built here is thrown away.
- **Seed derived from the authenticated Pyth Lazer price at lock.** Chosen over
  ephemeral-vrf. Rationale and the swap path are in "Randomness" below.
- **Rake** stays `RAKE = 0.05`, locked by `race-payout.test.ts`.

## The bug this closes

Today the winner is decided in the player's browser **before betting opens**:
`race-mode.ts:363` calls `setupRace()`, then `:364` calls `betPanel.openMarket()`. The
seed is a local `Math.random()` at `main.ts:1224` that is never hashed, stored, or sent
anywhere, and the wallet is `let wallet = 100.0` at module scope
(`redline3d/src/ui/bet-panel.ts:45`). Client picks the winner, client runs the book,
client pays itself.

In the new design the market opens with **no seed in the account**. The seed materializes
at lock from a price that does not exist yet. The winner cannot be known during betting —
not by the client, not by the house. Structural fix, not a patch.

## Accounts

### L1, never delegated

| PDA | Seeds | Purpose |
| --- | --- | --- |
| `Book` | `[b"book", mint]` | Race bankroll + rake accrual. Mirrors the master-pot half of raider's `HouseBalance`. |
| vault ATA | authority `[b"vault", mint]` | Token custody. Same pattern as `raider::init_house` (`onchain/raider/programs/raider/src/lib.rs:100`). |

### Delegated to the ER, long-lived

| PDA | Seeds | Purpose |
| --- | --- | --- |
| `Race` | `[b"race", mint]` | **Singleton.** Delegated once, permissionlessly, never torn down. |
| `Bettor` | `[b"bettor", owner, mint]` | Play balance. Same shape as raider's 81-byte `PlayerBalance`. |
| `Ticket` | `[b"ticket", owner, mint]` | Current-race stakes for one player. |

```rust
// Race
seq: u64,                 // race number, increments each cycle
phase: u8,                // 0 market, 1 racing, 2 settled
phase_ends_ts: i64,       // stamped when the phase is entered
entrants: [u8; 8],        // car ids
strengths: [u16; 8],      // strength × 1000, from the rarity table
pools: [u64; 8],
total: u64,
order: [u8; 8],           // finish permutation, stamped at lock
seed: [u8; 32],           // zero until lock
feed: Pubkey,             // Lazer feed pinned for this race
rake_accrued: u64,        // swept to L1 by commit_race
history: [Result; 32],    // ring buffer

// Result
seq: u64, winner: u8, mult_fp: u64

// Ticket
race_seq: u64,
stakes: [u64; 8],
```

### Constants

`MARKET_SECS = 15`, `RACE_SECS = 40`, `FINISH_SECS = 6`, `SCALE = 1_000_000`,
`RAKE_FP = 50_000` (5%, matching `RAKE` in `race-payout.ts`).

`RACE_SECS = 40` gives the client slack over its own worst case: last place finishes at
`30 + 7*0.8 + rng*0.4` ≈ 36.0s (`race-mode.ts:351`). The chain sets the window; the
client renders inside it.

`strengths` mirrors the rarity table at `redline3d/src/core/race-grid.ts:10`
(`{1:1.0, 2:1.35, 3:1.8, 4:2.4, 5:3.2}`) scaled by 1000, so `[1000, 1350, 1800, 2400, 3200]`.

### Why `Ticket` has no race id in its seeds

A player delegates **once** and then bets every race forever with no further delegation.
This is the central UX constraint: `delegate()` costs a 25×1s owner poll
(`redline3d/src/chain/chain-round.ts:291`) and cannot be paid every 60 seconds. A
per-race ticket PDA would require exactly that.

Stale tickets reconcile by comparing `ticket.race_seq` against `race.seq` — the same
corpse-reconciliation pattern already used for rounds in
`redline3d/src/chain/game-session.ts:385`.

## Instructions

### L1

`init_book`, `init_race`, `delegate_race`, `join`, `delegate_bettor`, `deposit`,
`withdraw`, `commit_and_undelegate_bettor`.

All near-copies of raider's existing vault path (`buy_in` at `lib.rs:140`, `withdraw` at
`lib.rs:172`, `delegate_session` at `lib.rs:231`). `delegate_race` is permissionless and
runs once for the lifetime of the book; `delegate_bettor` runs once per player and
co-delegates `Bettor` + `Ticket`.

### ER

**`place_bet(car_id, amount)`** — requires `phase == 0`. If `ticket.race_seq != race.seq`,
first settle the previous race from `history` and credit any winnings, then zero `stakes`
and adopt the current `seq`. Debit `Bettor.balance`, add to `pools[car_id]` and `total`.

**`race_crank`** — **no signer**, validator-executed. Copies the account shape of raider's
`tick_crank` (`lib.rs:593`, context `CrankClose` at `lib.rs:1389` has no `Signer` slot).
The whole state machine:

- `phase == 0` and `now >= phase_ends_ts` → `read_fresh` the pinned Lazer price;
  `seed = keccak(seq ‖ price_raw ‖ price_ts)`; compute `order[8]` weighted by
  `strengths`; stamp `seed` and `order`; `phase → 1`.
- `phase == 1` and `now >= phase_ends_ts` → settle (below); push
  `Result { seq, winner: order[0], mult_fp }` to `history`; `phase → 2`.
- `phase == 2` and `now >= phase_ends_ts` → `seq += 1`, pick new entrants, zero `pools`,
  `total`, `order`, `seed`; `phase → 0`.

**`claim`** — explicit payout against `history`, for players who do not bet again. The
auto-settle inside `place_bet` covers the common path; `claim` covers the player who
walks away.

**`commit_race`** — permissionless, in-ER. Calls `commit_accounts` on `Race` **without
undelegating**, then zeroes `rake_accrued`. See "Rake reaches L1" below.

### Settlement math

At settle, with `w = order[0]`:

```
rake      = total * RAKE_FP / SCALE
payable   = total - rake
mult_fp   = payable * SCALE / pools[w]      // if pools[w] > 0
payout_i  = stakes[w] * mult_fp / SCALE
```

`rake` is added to `rake_accrued`. Bettors are credited to `Bettor.balance` in-rollup, not
paid out of the vault — withdrawal is a separate L1 step, exactly as in raider.

**Nobody bet the winner (`pools[w] == 0`).** `mult_fp = 0` and the entire `total` goes to
`rake_accrued`. There are no stakes on `w` to divide by and no claim can reference it, so
this is the only coherent outcome — but it must be an explicit branch, not an accidental
division by zero. The house takes the pool in that race.

### Rake reaches L1

`Race` is permanently delegated and never undelegates, so raider's
"commit once at session end" model does not apply and rake would otherwise be stranded in
the rollup forever. `commit_race` uses `commit_accounts` — commit **without**
undelegation, which raider does not currently use anywhere (`lib.rs:864` is
`commit_and_undelegate_accounts`). A keeper calls it periodically; it is permissionless,
so anyone can.

This doubles as the audit trail: each commit publishes the `history` ring to L1, giving
race results a base-layer record without a per-race L1 transaction.

## Randomness

`seed = keccak(race.seq ‖ price_raw ‖ price_ts)`, where the price comes from
`price::read_fresh` against the feed pinned in `race.feed`.

Chosen over ephemeral-vrf because:

- `price.rs` already decodes authenticated Lazer prices **inside the rollup**, with the
  in-ER feed owner pinned at `onchain/raider/programs/raider/src/price.rs:38` and a
  30-second staleness gate in both directions.
- `crate-roll`'s VRF runs on **L1** (`redline3d/src/chain/crate-roll.ts:45` uses
  `BASE_RPC`). Whether ephemeral-vrf can be consumed in-ER is **unverified**. Making it
  load-bearing in a continuous 60-second cycle means either verifying that or leaving the
  rollup every single race.
- Consistency: raider already settles leveraged positions on that exact price at a moment
  nobody controls. If it is trustworthy enough for that, it is trustworthy enough to pick
  a race winner.

Weakness, stated plainly: the fairness argument is less legible than a VRF word, and it
rests on the low-order digits of a price at a precise timestamp being unpredictable and
unsteerable. Mitigation is in risk 3 below.

**Swap path.** If VRF is wanted later, only the seed-production branch of `race_crank`
changes — `order[8]` and everything downstream are untouched.

## Client changes

**Chain computes `order[8]`; client reads it.** Do not reimplement the scoring in both
Rust and JS — that would force cross-language float determinism for no benefit. The chain
owns the permutation. `calibrateBase()` keeps doing its float back-solve locally to hit
that order, and the renderer is otherwise untouched.

`redline3d/src/ui/bet-panel.ts`:
- `pools`, `userStake`, `wallet` (`:199-201`, `:45`) read from the ER `Race` and `Ticket`
  accounts instead of module state.
- `placeBet` (`:230`) becomes a transaction.
- The fake-bettor inflow at `FLOW_INTERVAL` (`:275-287`) is **deleted**. Real bettors
  replace it, and it was the only thing making odds non-reproducible from the seed.
- The duplicated `mulberry32` at `:47-55` goes with it.

`redline3d/src/render/race-mode.ts`:
- `setupRace()` takes the on-chain `order[8]` instead of deriving one from a local seed.
  `OUTCOME_NOISE` scoring moves to the chain.
- Phase transitions driven by on-chain `phase` / `phase_ends_ts`, interpolated between
  polls, rather than local timers. The existing 650ms ER poll cadence
  (`redline3d/src/main.ts:2362`) is sufficient.
- Auto-restart's fresh `Math.random()` seed at `:401` is removed — the chain rolls races.

Cycle: 15s market → 40s race window (client fills ~36s of it) → 6s finish ≈ **61s**.

## Crank

`schedule_tick`'s `MagicBlockInstruction::ScheduleTask` CPI (`lib.rs:614`) with
`execution_interval_millis: 1000`. Re-arming follows the open-ended Highway precedent
(`HIGHWAY_CRANK_ITERATIONS = 24*60*60`, `redline3d/src/chain/chain-round.ts:91`) with
coverage re-armed opportunistically from `place_bet`.

**VERIFIED 2026-07-27 — the scheduled task actually executes.** `paddock-e2e.ts` drives
`race_crank` manually and asserts only that `schedule_race_crank` is *accepted* (that the
CPI does not error). Acceptance is not execution, so whether MagicBlock's scheduler ever
invokes the crank was an open question. `tests/paddock-crank-liveness.ts` settles it: arm
the crank, then poll only — the file never calls `race_crank`. Result over 150s with zero
client transactions:

```
t=0    seq=0 MARKET  (armed here)
t=6s   seq=0 RACING     t=41s  seq=0 SETTLED
t=46s  seq=1 MARKET     t=56s  seq=1 RACING     t=96s  seq=1 SETTLED
t=101s seq=2 MARKET     t=111s seq=2 RACING     t=146s seq=2 SETTLED
```

Three complete race cycles, unattended. **Races self-run: no keeper process, and therefore
no centralised liveness dependency.** The client is a pure reader-and-bettor. This also
retires an assumption the anti-grinding mitigation below silently rested on — "the
scheduled crank runs ~1s and takes the first in-band price" is now measured, not hoped for.

## Risks, in the order they should be tested

1. **Multi-payer delegation to one validator.** `Race` is delegated by the house;
   `Bettor` / `Ticket` by each player, at different times. All must land on
   `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` to be writable in a single ER
   transaction. **Unverified, and it kills the design if wrong — spike this first,
   before any other work.**
2. **Write contention on `Race`.** N bettors mutating `pools` in the same slot.
   `onchain/raider/tests/raceguard.ts` covers this bug class for raider; throughput under
   real concurrency is unmeasured here.
3. **Lock-timing influence — the original claim here was WRONG.** This section used to
   read: *"The crank fires on a schedule armed in advance by the validator, so nobody
   with a stake in the outcome chooses which price is read."* That premise is false.
   `race_crank` has **no signer at all** — the MagicBlock scheduler executes it with
   every account meta marked `is_signer: false`, which is inherent to the scheduled-task
   pattern and matches raider's `tick_crank`. The instruction is therefore
   **permissionless**: the validator is merely one caller among many.

   The resulting attack is practical, not theoretical. `race_seed` and `draw_order` are
   pure public functions, and `read_fresh` accepts any price inside `STALE_SECS` (30s).
   An attacker bets a slot, watches the Lazer feed, computes what the winner *would* be
   for the currently-published price, and fires `race_crank` themselves the moment it
   favours them. The lock is one-shot, so the first transaction to flip the phase fixes
   the seed permanently. At Lazer's cadence that is dozens of free rolls per race —
   enough to land a chosen winner near-certainly. The attacker need not even be the
   bettor; the capability is sellable.

   **Mitigation shipped** (`618fb42`): the seeding price must be published inside
   `LOCK_WINDOW_SECS` (2s) of the committed `phase_ends_ts`, not anywhere in the 30s
   staleness window. The scheduled crank runs ~1s and takes the first in-band price, so
   an attacker is reduced from grinding ~30s of prices to racing the honest crank inside
   a single slot. On a miss the band **slides** rather than widening — widening is
   exactly the grinding surface — and bands tile contiguously so liveness is preserved.

   **This narrows the exposure; it does not remove it.** The real fix is VRF, where the
   output cannot be steered by submission timing at all. The repo already runs
   MagicBlock `ephemeral-vrf` in `crate-roll`, though on **L1** rather than in-rollup, so
   in-ER support must be verified before it can be load-bearing. Chosen deliberately as
   the interim; **must be closed before mainnet or before this is shown as a fairness
   claim.**
4. **`commit_accounts` without undelegation is unproven here.** Raider only ever calls
   `commit_and_undelegate_accounts` (`lib.rs:864`); a bare periodic commit is a new code
   path in this repo. Rake extraction and the L1 audit trail both depend on it. Prove it
   in the same spike as risk 1.
5. **Claim window.** A 32-deep `history` ring at ~61s/race gives roughly 32 minutes to
   claim. Beyond that a stake is unclaimable. Acceptable because the client auto-claims on
   its next `place_bet` and on poll, but the UI must say so.

## Out of scope

- Player-entered cars in the grid, and the owner podium payout that depends on them.
- Mainnet. This is devnet-first, and `paddock` is a new program — not a small detour.
- Matchmaking, lobbies, or more than one concurrent race.
- Moving the race physics on-chain, now or later.
