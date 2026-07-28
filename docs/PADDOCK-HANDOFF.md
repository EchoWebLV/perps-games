# Paddock Race Book — Handoff

**As of 2026-07-28.** Branch `paddock-race-book`, **not pushed** (180 commits ahead of `origin/main`).

Read this before touching anything. Several of the traps below are bugs that do not crash — they
produce plausible, wrong output.

---

## 1. What this is

`paddock` is an Anchor program at `onchain/raider/programs/paddock/` — a **shared pari-mutuel race
book** running its betting market and settlement inside a MagicBlock Ephemeral Rollup (ER). Players
bet on which of 8 cars wins a continuously-cycling house race. It is a second program alongside the
existing `raider` perps program, in the same workspace.

**The core design split, decided deliberately: the chain owns the RESULT, the client owns the SHOW.**

The race sim is not a simulation. `calibrateBase()` in `redline3d/src/render/race-mode.ts`
back-solves each car's speed from a finish order *chosen in advance*, so the physics stays in the
browser and the chain only supplies `order[8]`. **Never port the 8,640-substep float sim on-chain** —
it buys nothing and forces Rust/JS float determinism.

**Status: devnet only. Nothing is on mainnet-beta.** The full loop is proven end to end from a real
browser: a wallet onboards, bets, watches a chain-decided race, claims, and cashes out.

---

## 2. Addresses and environment

### Live devnet book (self-running)
```
program           3wz2kwDSGZEfdwing4FucjveWunnpiwoYAnKUAbKRh2S
mint              So11111111111111111111111111111111111111112   (wSOL, 9 decimals)
book              GAycEgCi56NLWpW6whqE4aeM7UfgzFjJPE1ytsYutnDS
race              5NfLJyVMRns3uPzuXRJnTdyf2Y9rRwhzg1TTN9QcofVs
vault authority   D8RX6NsFMFaeHq8wicD3SibcZnpzCTKc9fm6uXUPGa16   (bare PDA, never allocated)
vault ATA         AoNrNMBwY4xP4rQrEDmLWjAYhBohe2dFALesZQfbrDgy
validator         MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57
price feed (BTC)  71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr   (Pyth Lazer)

L1   https://api.devnet.solana.com
ER   https://devnet.magicblock.app        (ws: wss://devnet.magicblock.app)
```

### Wallets — read this before running anything
| Wallet | Pubkey | Balance | Note |
| --- | --- | --- | --- |
| `~/.config/solana/id.json` | `HKVgAY…` | **0.9568 SOL** | The house / upgrade authority. **Use this one.** |
| `~/.config/solana/lazer-probe.json` | `FP39zt…` | **0 SOL** | What `Anchor.toml` points at. **Empty — do not use.** |

`anchor test` reads `Anchor.toml`'s wallet, which is empty. Run tests with the env explicitly:
```bash
ANCHOR_WALLET=$HOME/.config/solana/id.json ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
  yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/<file>.ts
```

**Devnet SOL is a real constraint right now.** Airdrops are rate-limited on every endpoint tried;
Ankr needs an API key; there are no stranded buffers to reclaim. A **standing user directive**
applies: *never ask the user to fund a devnet wallet* — reclaim buffers, airdrop, or use a web
faucet yourself. Closing a *buffer* needs no permission; closing a *program* is irreversible and
**must be asked first**.

There is ~2.2 SOL reclaimable from a throwaway spike, pending the user's decision — see §6.

---

## 3. What is proven, and by what

Nothing in this table is an argument; each row is something that was observed.

| Claim | Evidence |
| --- | --- |
| A house-delegated shared `Race` and separately-delegated `Bettor`/`Ticket` are co-resident in one rollup and writable in ONE ER transaction | `onchain/raider/tests/paddock-gate.ts` — this was the load-bearing assumption of the whole design |
| `commit_accounts` leaves an account delegated AND ER-writable | Confirmed live; raider only ever used the undelegating variant |
| Full loop, two wallets, one shared pool | `tests/paddock-e2e.ts`, 7/7 |
| The scheduled crank fires with **no client transactions** | `tests/paddock-crank-liveness.ts` — poll-only, never calls `race_crank` |
| The client library round-trips against the live book | `redline3d/src/chain/paddock.devnet.test.ts` |
| Pari-mutuel math is exact | Backing all 8 slots at 10,000 each returned 76,000 on an 80,000 pool — stake minus exactly the 4,000 rake |
| Cash-out returns real SOL | Reconciles to the lamport, two independent runs |
| Rake reaches the house | `sweep_rake` credited 16,000 lamports on the live book; a second sweep credited 0 |
| A real browser click bets, races, and gets paid | Cross-checked by an independent node process; pool and total each moved by exactly the stake |
| In-ER VRF works from a **no-signer scheduled crank** | `spikes/vrf-signer-probe/` — 11/11 requests, 11 callbacks, 10 scheduler-driven |

**Test commands.** From `redline3d/`: `npx vitest run` (1207 pass / 12 skip) and `npx tsc --noEmit`
(clean). Devnet client tests are gated: `PADDOCK_DEVNET=1 npx vitest run --config
vitest.config.devnet.ts`. Program unit tests: `cargo test -p paddock --lib` (27 pass).

---

## 4. Traps that will bite you

**These are the reason this document exists.** Each was found the expensive way.

### 4.1 SLOT ≠ CAR
The crank **permutes the grid on every race roll**. Live example:
```
entrants  [2,4,0,6,3,1,5,7]
strengths [1800,1350,3200,1000,1800,2400,1800,1000]
slot 0 -> entrant 2 = Cybertruck     slot 2 -> entrant 0 = Bedrock
```
- `pools[i]`, `stakes[i]`, `order[]`, and `place_bet`'s `car_id` are all **slot**-indexed.
- `entrants[i]` is the **car** in slot `i` — an index into `DEFAULT_GRID`.
- The entrant↔strength pairing IS preserved under permutation, but `strengths[i]` is still not
  "car i's strength".

Seen live: a winner at **slot 0 holding car 6** (Big Frank, strength 1000). Reading `strengths[0]`
would have announced Bedrock at 3200. **This bug does not crash — it shows correct odds against the
wrong car name and pays the wrong one.**

`RaceBookSource` (`redline3d/src/render/race-book-source.ts`) is designed so slots **cannot cross
the boundary** — every array on that interface is car-indexed and each implementation resolves its
own map internally. Preserve that property.

### 4.2 `Race.order` is ZEROED during MARKET
It is written only at the **lock**, in the same instruction as the seed. Asserting "order is always
a permutation" is wrong; the invariant is phase-dependent (MARKET ⇒ seed *and* order both zero).
Corollary: **the `entrants` array captured AT LOCK is the only one valid for naming a settled
winner**, because the next roll permutes the grid.

### 4.3 An aged-out ticket returns NO ERROR
Unclaimed winnings expire after 32 races (`HISTORY_LEN` ring). `claim` raises `NoSuchResult` (6008)
**only** for the `u64::MAX` sentinel and `WrongPhase` (6006) **only** for the live race. Past the
ring there is no error at all: `settle_ticket` finds nothing, credits 0, and `claim` zeroes the
stakes and resets `race_seq` anyway. `place_bet`'s auto-settle does the same. The money does not
bounce off a catchable error — **it silently stops existing.** (`AlreadyClaimed` (6009) is declared
at `lib.rs:874` and never constructed.)

### 4.4 The `u64::MAX` ticket sentinel
`Ticket.race_seq == u64::MAX` means "no ticket". The history ring is zero-initialised, and a zeroed
slot is **bit-identical** to `{seq: 0, winner: 0, mult_fp: 0}` — so `find_result(0)` returns
`Some(..)` from the moment the account exists. Every caller must reject the sentinel *before* the
lookup. The client enforces this at the type level: `ticketToSnap` collapses it to
`raceSeq: bigint | null` and `findResult` takes the nullable. **Keep it that way.**

### 4.5 The settled-window timing trap
During `PHASE_SETTLED` the result is already in the ring, so a live winning ticket **looks**
claimable to `settleTicket` while `claim` still rejects it with `WrongPhase` (`race_seq !=
race.seq`). Any live-race check must come **first**, or a cash-out in that ~6s window sends a
transaction that can only fail.

### 4.6 L1 vs ER — which endpoint
| L1 (`BASE_RPC`) | ER (`ER_RPC`) |
| --- | --- |
| `join`, `deposit`, `withdraw`, `init_*`, `delegate_*`, `sweep_rake`, `withdraw_rake` | `place_bet`, `claim`, `race_crank`, `commit_race`, `exit_bettor`, `schedule_race_crank` |

Ordering rules that follow from this, both already documented in code:
- `deposit` must precede `delegate_bettor` — a delegated `Bettor` fails anchor's L1 owner check.
- `exit_bettor` must precede `withdraw` — same reason, mirrored.

### 4.7 Anchor IDL casing
`anchor-ts` runs `convertIdlToCamelCase` in the `Program` constructor, so
`program.coder.accounts.decode("Race", …)` throws `Account not found: Race` — the key is `"race"`.
This matters because L1's `Race` is owned by the delegation program, so the typed
`program.account.race.fetch` refuses it and manual decoding is the only route.

### 4.8 Sending transactions
Use the repo's HTTP-poll send path (`sendIxHttp` in tests, `send()` in `chain/paddock.ts`), not
plain `.rpc()`. There is an rpc-websockets v9 incompatibility; the existing code works around it.

---

## 5. What is left, ranked

### 5.1 A liveness WATCHDOG — do this first
**The most important open item, and it is a correction to an earlier claim.**

"Races self-run, no keeper needed" was too strong. What is true:
- ✅ **No per-race keeper.** No client transaction is needed for any phase transition. Measured
  across ~40 races.
- ❌ **But the scheduled task is not durable.** The live book was found **dead: stalled at seq 136
  in MARKET, 13,788 seconds past its deadline**, the task simply gone despite being armed for
  1,000,000 iterations it had not exhausted. The feed was fresh, so not a `StalePrice` stall.
- ❌ **Nothing on chain records that a task exists.** `magicblock-magic-program-api` 0.10.1 exposes
  only `ScheduleTask`/`CancelTask` with a caller-chosen `i64 task_id` and no readable task PDA.
  **The only detection is behavioural** — watch `phase_ends_ts` go overdue.

So the requirement is a **watchdog, not a keeper**: check periodically whether the phase is overdue
and re-arm if so. Re-arming is already implemented and idempotent — step 4 of
`onchain/raider/scripts/paddock-house-setup.mjs`, and it costs 0 SOL (ER transaction). **Unbuilt. An
unattended book silently stops taking bets.**

### 5.2 The VRF swap — gated, viable, unbuilt
**Why:** `race_crank` has no signer (inherent to the scheduled-task pattern) so it is
**permissionless**, and the market lock samples the price that seeds the winner. `race_seed` and
`draw_order` are pure public functions, so a caller can compute what the winner *would* be and fire
the crank when it favours them. Mitigated (`618fb42`) by requiring the seeding price to publish
inside `LOCK_WINDOW_SECS = 2` of the committed `phase_ends_ts`, with the band **sliding** on a miss
rather than widening. **That narrows it; it does not close it.**

**Everything blocking the swap has been resolved:**
- In-ER VRF exists and is co-located with paddock's rollup, on devnet **and** mainnet. Free on
  `DEFAULT_EPHEMERAL_QUEUE` (`5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc`).
- A **no-signer scheduled crank CAN issue a request**, using the program identity PDA as both
  `payer` and `program_identity`. Proven 11/11 in `spikes/vrf-signer-probe/`.
- **The one-line fix you will need:** `ix.accounts[0].is_writable = false;` after the SDK builder.
  The ER refuses a writable non-delegated account and rejects at the transaction admission layer
  **after execution succeeds** — the log reads like a pass right up until the transaction is thrown
  out:
  ```
  Program log: VRF REQUEST OK (variant 1)     <- the CPI SUCCEEDED
  Program log: Account 2: 8q5tiW5g… was illegally used as writable
  Program Magic1111… failed: InvalidWritableAccount
  ```
  Legal because `request_randomness.rs` only ever calls `is_signer()`, never `is_writable()`, and
  `fees.rs` exempts the ephemeral queue. Proven with the identity PDA non-existent and zero-lamport
  on both layers.
- Callback layout: `discriminator || randomness[32] || callback_args` → handler signature is
  `fn callback(ctx, randomness: [u8;32], ...args)`.
- The scheduler propagates the wider six-account meta list with per-meta privileges intact — **no
  `PrivilegeEscalation` problem.**

**Scope warning — the spec used to understate this.** It is NOT "change the seed-production branch."
It is a **phase-machine change**: add `PHASE_LOCKING` (value 3) where the crank closes betting and
requests, plus a `callback_race_seed` signed by the VRF identity that writes `seed`, computes
`order`, and flips to `PHASE_RACING`. Costs 1–3 ER slots, invisible in a 61s cycle.

**The design that looks obvious and is fatally wrong: do NOT request randomness a phase early.** If
it lands during `PHASE_MARKET`, `race.seed` is public while bets are still open and `draw_order` is
a pure public function — strictly worse than the hole it replaces.

Other constraints:
- **No new `Race` field.** `Race::SIZE` is exactly 778 with no slack and the account is already
  delegated, so a realloc means undelegate → realloc → redelegate. Use
  `phase == PHASE_LOCKING && seed == [0;32]` as the request-outstanding marker; bind the callback to
  a race via `race.seq` in `callback_args`.
- `schedule_race_crank` hardcodes the crank's metas — it must be **re-armed** with the wider list.
- **Build hazard:** depend on `ephemeral-vrf-sdk` **directly** with `anchor-compat`, exactly as
  `crate-roll` does. Enabling `ephemeral-rollups-sdk/vrf` flips the proc-macro's path emission for
  every co-built program and **breaks `crate-roll`**.
- **Trust moves, it does not vanish.** The VRF proof means the oracle cannot *bias* the number, but
  it can *withhold* it — a liveness dependency paddock does not have today. `PHASE_LOCKING` needs a
  timeout that **re-requests** rather than falling back to the price.
- Requires a program upgrade → needs **~3.1 SOL** transiently for the write buffer (refunded on
  success). Not currently affordable; see §6.

### 5.3 No top-up for a delegated bettor
A returning player's most likely failure. `deposit` writes `Bettor` on **L1**, but a delegated
`Bettor` rejects L1 writes. So a player who spends down cannot add funds without
`exit_bettor` → `deposit` → `delegate_bettor`, paying the one-time owner poll again. `ensureBettor`
returns `"ready"` and the next `placeBet` fails `InsufficientBalance`.

This is a **program-shape** problem, not a client bug. Two ways out, both needing a decision:
wire exit/withdraw into the flow and accept the re-delegation cost, or add an L1 pending-deposit
account the crank sweeps into `Bettor.balance` in-rollup.

### 5.4 Onboarding vs the 15s market window
`MARKET_SECS` is 15; the delegation poll alone allows 25 on top of four confirmed transactions. A
**first-time** player's first bet therefore lands after the lock and fails `WrongPhase`. The panel
makes this legible, but it is still a bet they asked for and did not get.

**Narrower than first thought:** a *returning* wallet (Bettor/Ticket exist but undelegated) completes
wrap→deposit→delegate inside one 15s market and its bet lands. Only the first-time path including
`join` reliably overruns. *(A separate session was working this.)*

### 5.5 Smaller open items
- **The house has no wSOL token account** (`AJarT4TXazGj3MtMkwBvAVNuxXggs6SVCQ1gEvpXopd` does not
  exist), so `withdraw_rake` on the live book fails today. `scripts/paddock-rake-collect.mjs` prints
  the exact `spl-token create-account` remedy. `withdraw_rake` itself is proven against a test mint.
- **`redline3d/.env`'s `VITE_BASE_RPC` (Helius free devnet) is hard-down — 503 on every attempt.**
  This breaks client onboarding at the first L1 read. A `.claude/launch.json` entry
  (`redline3d-paddock`, port 4200) overrides it to public devnet; the `.env` itself is untouched.
- **The panel only paints during MARKET**, so onboarding progress vanishes for ~46s of every 61s
  cycle.
- **The BET button never gates on balance once `onboard` is wired** — `canFund = wallet >= stake ||
  onboarding !== null`, and `onboarding()` is always non-null in bet mode. Deliberate for the first
  bet, arguably wrong after it.
- **Nothing schedules `sweep_rake`.** It is permissionless and idempotent, but manual.
- **3,132,000 lamports stranded per player** (Bettor + Ticket rent) — paddock has no close
  instruction. `exit_bettor` reclaims the delegation PDAs (~6.18M of ~9.91M), so this is what
  remains.
- `settle_pool` / `payout_of` truncate on their final `as u64`. Bounds are *ratios*, unreachable at
  realistic supplies. Deliberately uncapped.
- `init_book` is first-come (same posture as raider's `init_house`). The house already won it.

---

## 6. Decisions for the user — do NOT make these yourself

1. **Close the VRF spike to reclaim ~2.2 SOL?** `id.json` is at 0.9568 SOL, which does not cover the
   VRF swap's program upgrade. The throwaway spike holds ~2.2 SOL:
   ```
   solana program close DPRXzxfKbh4ht1jr28QSnZ5XTavqhA6PrH9fuDT7HFJs --bypass-warning -u devnet
   ```
   Irreversible — the program id can never be reused. **Ask first.**
2. **Mainnet?** MagicBlock Forge Epoch 01 closes **2026-07-31**, theme Mainnet; nothing of ours is
   on mainnet-beta. A mainnet deploy puts real money behind the grinding hole until §5.2 ships.
3. **Flip `play/` to chain mode?** The shipped game still runs the local sim. Chain mode lives behind
   `?chain=1` / `?bet=1` on the dev harness, which is **not** in the build
   (`vite.config.ts:73-78` — inputs are `index.html` and `play/index.html` only).
4. **Which top-up fix** (§5.3).
5. **Push the branch?** 180 commits ahead of `origin/main`, local only.

---

## 7. Map of the code

### Program — `onchain/raider/programs/paddock/src/`
| File | What |
| --- | --- |
| `state.rs` | `Book` (121B), `Bettor` (81), `Ticket` (113), `Race` (778), `RaceResult` (17). Sizes locked by `account_sizes_are_locked`. Constants: `MARKET_SECS` 15, `RACING_SECS` 40, `SETTLED_SECS` 6, `LOCK_WINDOW_SECS` 2, `HISTORY_LEN` 32, `GRID` 8. |
| `book.rs` | Pure pari-mutuel math — `settle_pool`, `payout_of`, `sweep_rake`. Anchor-free, `cargo test` fast loop. `SCALE = 1_000_000`, `RAKE_FP = 50_000` (5%). |
| `draw.rs` | Pure weighted finish-order draw — `race_seed`, `draw_order`. Sampling without replacement. |
| `lib.rs` | 16 instructions + account contexts. |

Instructions: `init_book`, `init_race`, `join`, `deposit`, `withdraw`, `delegate_race`,
`delegate_bettor`, `place_bet`, `race_crank`, `claim`, `commit_race`, `exit_bettor`,
`schedule_race_crank`, `process_undelegation`, `sweep_rake`, `withdraw_rake`.

### Client — `redline3d/src/`
| File | What |
| --- | --- |
| `chain/paddock.ts` | `createPaddockBook`, `derivePaddockPdas`, `ensureBettor`, `cashOut`, snapshots, BigInt mirrors of `book.rs`. |
| `chain/idl/paddock.{ts,json}` | Checked-in IDL copy. **Re-copy from `onchain/raider/target/` after any program deploy.** |
| `render/race-book-source.ts` | The `RaceBookSource` seam + `localBookSource()` + the chain implementation. |
| `render/race-mode.ts` | The race. Takes optional `book?: RaceBookSource`; **absent ⇒ identical to the pre-chain behaviour.** |
| `ui/bet-panel.ts` | Pure view — renders what it is given, emits intent. Owns no money. |
| `race-preview.ts` | Dev harness. `?chain=1` read-only, `?bet=1` funded. |

### Scripts and tests
```
onchain/raider/scripts/paddock-house-setup.mjs    idempotent book setup; step 4 re-arms the crank
onchain/raider/scripts/paddock-rake-collect.mjs   commit_race -> sweep_rake against the live book
onchain/raider/tests/paddock-gate.ts              the co-residency gate
onchain/raider/tests/paddock-e2e.ts               full loop, two wallets
onchain/raider/tests/paddock-crank-liveness.ts    poll-only; NEVER calls race_crank
onchain/raider/tests/paddock-rake.ts              12 devnet rake cases
redline3d/src/chain/paddock.devnet.test.ts        client round trip (PADDOCK_DEVNET=1)
spikes/vrf-signer-probe/                          throwaway; holds ~2.2 SOL
```

### Docs
- `docs/superpowers/specs/2026-07-27-onchain-race-book-design.md` — the design, **with its own
  refutations inline.** Two claims in it were proven wrong and are marked as such; read the
  correction blocks, not just the original text.
- `docs/superpowers/plans/2026-07-27-paddock-race-book-program.md` — the program plan (complete).
- `docs/superpowers/plans/2026-07-27-paddock-client-integration.md` — the client plan (complete).

---

## 8. Working rules that apply to this repo

From the user's global `CLAUDE.md` and standing directives. These override default behaviour.

- **No time estimates — ever.** Never say days, hours, weeks, "an afternoon". List the remaining
  work items instead and let the user judge. This applies to code, comments, and UI copy.
- **Never assume — verify.** Assert nothing not checked against ground truth: the code, a command's
  output, a doc. Say "unknown" rather than filling the gap. This document tries to mark inference
  as inference; keep that discipline.
- **Build only what is asked.** No unprompted caps, throttles, retries, or safety scaffolding.
  Surface a money risk once, then build what was asked.
- **Devnet SOL: get it yourself.** Never ask the user to fund a devnet wallet. Buffers → airdrop →
  web faucet. Closing a *program* is the one exception that needs permission.
- **Verify UI in a browser before claiming done.** Passing tests and a clean typecheck are not
  evidence the UI works. Two real bugs here were found only by loading the page — a book polling on
  sim `dt` while its clock read `Date.now()`, and the dead crank.
- The user acts as CTO/planner and delegates implementation to subagents with scoped,
  non-overlapping file sets.

---

## 9. Commits

```
b87012c  a real browser click bets, races and gets paid
42350af  spec: VRF signer gate PASSED
dae9452  the house can collect its rake
1cd5d69  make onboarding and the claim window legible
db679c1  cash-out — money can finally come back out
6ccaf71  the race renders from the chain, proven in a browser
eaf5ab2  client onboarding + the loop proven end-to-end on devnet
0cf53ee  RaceBookSource seam + the bet panel stops owning money
d61fd51  live wSOL book on devnet + typed client library
06616bb  prove the scheduled crank fires unattended
```
Earlier program work is under `bf7a8fd` and before.
