# Paddock Client Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the proven `paddock` program to the game, so a real wallet bets real tokens into the on-chain pari-mutuel pool and watches a race whose winner was decided on-chain — replacing the fake pools, fake bettors, fake wallet, and browser-chosen finish order that ship today.

**Why this and not VRF:** `paddock` is a proven engine with no car around it. Nothing in `redline3d` touches it — the IDL has never been copied into the client. The grinding hole that VRF closes is a **mainnet** blocker, and nothing is on mainnet; it is recorded and deferred, not forgotten (see Deferred, below).

**Architecture — the seam that makes this safe:** `race-mode.ts` is 689 lines, is in the shipped app (`main.ts:96`), and has passing tests. It does **not** get rewritten. It gains one optional dependency:

```ts
interface RaceGameOptions { /* …existing… */ book?: RaceBookSource }
```

- `book` absent → today's local sim, byte-for-byte. Dev harness, landing preview, and every existing test keep passing untouched.
- `book` present → phases, pools, wallet and finish order come from the chain.

Every task below is additive behind that seam. No task is allowed to change what happens when `book` is undefined.

**The substitution that makes this cheap:** `calibrateBase()` (`race-mode.ts:313`) already back-solves each car's speed from a finish order *chosen in advance* — that is what `setupRace()` (`:342`) feeds it via `strengths[i] + rng() * OUTCOME_NOISE`. The chain hands us `order[8]`. So the on-chain path deletes one scoring line and passes the chain's order into machinery that already exists. This is the spec's "chain owns the RESULT, client owns the SHOW" cashing out.

**Tech stack:** existing `redline3d/src/chain/` layer (Anchor 0.31.1 TS client, `AnchorWalletLike`, `sendIxHttp` HTTP-poll sends), Vitest for unit tests, devnet ts-mocha for the client-against-chain test, browser verification against devnet.

**Spec:** `docs/superpowers/specs/2026-07-27-onchain-race-book-design.md`
**Program plan (complete):** `docs/superpowers/plans/2026-07-27-paddock-race-book-program.md`

---

## Ground truth this plan was written against

Verified, not assumed:

| Fact | Where |
| --- | --- |
| Client has a mature ER layer for `raider` — round lifecycle, delegation, session | `redline3d/src/chain/chain-round.ts` (426 lines), `game-session.ts` (511) |
| **Zero** paddock client code exists; IDL never copied | `redline3d/src/chain/idl/` holds only `raider.ts`, `crate-roll.ts` |
| The browser picks the winner today | `race-mode.ts:347` — `strengths[i] + rng() * OUTCOME_NOISE` |
| The bet panel is explicitly fake | `bet-panel.ts:1-6` header; module-level `wallet = 100.0` at `:45`; fake inflow at `:275` |
| The race ships in the app | `main.ts:96` imports `createRaceGame`; build inputs are `index.html` + `play/index.html` |
| `race-preview.html` is a dev harness, NOT in the build | `vite.config.ts:73-78` |
| Deploy/house wallet is `id.json` (`HKVgAY…`), 3.49 SOL | `solana balance`; `Anchor.toml`'s `lazer-probe.json` is at 0 |

---

## File Structure

| File | Responsibility |
| --- | --- |
| `redline3d/src/chain/idl/paddock.ts` | Typed IDL, generated from `onchain/raider/target/idl/paddock.json`. Same shape as `idl/raider.ts`. |
| `redline3d/src/chain/paddock.ts` | PDAs + `PaddockBook` client: race snapshot, bettor snapshot, join/deposit/delegate, `placeBet`, `claim`. Mirrors `chain-round.ts`. |
| `redline3d/src/chain/paddock.test.ts` | Unit: PDA derivation, snapshot decoding, payout mirror vs `book.rs`. |
| `redline3d/src/chain/paddock.devnet.test.ts` | The client library driving the real devnet book end to end. |
| `redline3d/src/render/race-book-source.ts` | The `RaceBookSource` interface + a `localBookSource()` that reproduces today's fake behaviour, so the seam has two implementations from day one. |
| `onchain/raider/scripts/paddock-house-setup.mjs` | House-side one-time deploy: `init_book(wSOL)`, `init_race`, `delegate_race`, arm the crank. `init_book` is first-come — the house must win it. |
| `onchain/raider/tests/paddock-crank-liveness.ts` | **Written in Task 0.** Proves the scheduled crank fires unattended. |

Modified: `race-mode.ts` (seam + chain-driven phases/order), `bet-panel.ts` (de-faked to a pure view), `chain/config.ts` (paddock program id + book mint), `race-preview.ts` (opt-in chain mode for browser verification).

---

## Task 0: Crank liveness (GATE — the product shape depends on the answer)

`paddock-e2e.ts` drives `race_crank` **manually** and asserts only that `schedule_race_crank` is *accepted* — that the ScheduleTask CPI does not error (`tests/paddock-e2e.ts:11-14`, `:240-254`). Acceptance is not execution. Nothing has ever shown the scheduler actually invoking the crank.

This is load-bearing. If the task fires, races self-run and the client is a pure reader-and-bettor. If it is silent, a keeper process is a hard liveness dependency and a centralisation fact that belongs in the spec **before** any client code assumes autonomous races.

**Files:**
- Create: `onchain/raider/tests/paddock-crank-liveness.ts`

**Steps:**
- [ ] Stand up a fresh mint + book + race, delegate the race, arm the crank, then **poll only** — the file must never call `race_crank` or the measurement is destroyed.
- [ ] Watch longer than `MARKET_SECS + RACING_SECS` so a live crank must move the phase at least twice.
- [ ] Record the verdict in the spec either way. A silent scheduler means adding a keeper task to this plan.

**Run:** `ANCHOR_WALLET=~/.config/solana/id.json ANCHOR_PROVIDER_URL=https://api.devnet.solana.com yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/paddock-crank-liveness.ts`

---

## Task 1: House setup — a real wSOL book on devnet

The e2e used a throwaway 6-decimal mint. The client plays in wSOL (`config.ts:34`, `ACTIVE_STAKE_CURRENCY`) so the player flow stays "send SOL → bet". No wSOL book exists yet.

`init_book` is first-come with no authority gate (same posture as raider's `init_house`), so the house must call it before anyone else can squat the PDA.

**Files:**
- Create: `onchain/raider/scripts/paddock-house-setup.mjs`
- Modify: `redline3d/src/chain/config.ts`

**Steps:**
- [ ] Script: `init_book(wSOL, VALIDATOR)` → `init_race(entrants, strengths)` → `delegate_race` → `schedule_race_crank`, idempotent (skip any step whose account already exists).
- [ ] Seed `entrants`/`strengths` from the client's `DEFAULT_GRID` strengths so the on-chain grid and the rendered roster agree.
- [ ] Add `PADDOCK_PROGRAM_ID` and the book mint to `CHAIN`.
- [ ] Verify: fetch `Race` from the ER and confirm it is delegated, cranking, and cycling `seq`.

---

## Task 2: Typed IDL + `PaddockBook` client

**Files:**
- Create: `redline3d/src/chain/idl/paddock.ts`, `redline3d/src/chain/paddock.ts`, `redline3d/src/chain/paddock.test.ts`

**Steps:**
- [ ] Generate the typed IDL from `target/idl/paddock.json`; assert the program id matches `Anchor.toml` in a test, as `idl.test.ts` already does for raider.
- [ ] `derivePaddockPdas(programId, owner, mint)` → book, race, vault, bettor, ticket. Mirror `deriveRaiderPdas` (`chain-round.ts:17`).
- [ ] `raceSnapshot()` → `{ seq, phase, phaseEndsTs, entrants, strengths, pools, total, order, seed }` read from the ER.
- [ ] `bettorSnapshot()` → `{ balance, stakes[8], raceSeq }`. **Must** treat `raceSeq === u64::MAX` as "no ticket" — the sentinel guard the program's `find_result` hazard note demands.
- [ ] Port `settlePool`/`payoutOf` from `tests/paddock-helpers.ts` as BigInt, and unit-test them against the same vectors the Rust tests use, so client and program agree to the unit.
- [ ] `placeBet(carId, amount)` and `claim()` sent to the ER via the existing HTTP-poll path.

---

## Task 3: The `RaceBookSource` seam (pure refactor — zero behaviour change)

**Files:**
- Create: `redline3d/src/render/race-book-source.ts`
- Modify: `redline3d/src/render/race-mode.ts`

**Steps:**
- [ ] Define `RaceBookSource`: `phase()`, `secondsLeft()`, `pools()`, `total()`, `myStakes()`, `wallet()`, `finishOrder()`, `placeBet()`, `poll()`.
- [ ] Implement `localBookSource()` reproducing today's exact behaviour — the seeded pools, the 0.8s fake inflow, the module-level wallet, the `OUTCOME_NOISE` draw.
- [ ] Route `race-mode.ts` through `options.book ?? localBookSource()`.
- [ ] Gate: `race-mode.test.ts` and `bet-panel.test.ts` pass **unmodified**. If either needs editing, the seam is wrong.

---

## Task 4: De-fake the bet panel

The panel currently owns money: it mutates a module-level wallet, invents bettors, and settles itself. It becomes a view that renders what it is given and emits intent.

**Files:**
- Modify: `redline3d/src/ui/bet-panel.ts`, `redline3d/src/ui/bet-panel.test.ts`

**Steps:**
- [ ] Delete the module-level `wallet`, `mulberry32` (duplicated from `race-mode.ts`), `tick()`'s fake inflow, and the wallet mutation in `settle()`.
- [ ] `render()` takes pools, total, wallet, stakes and multipliers from the ctx; `onBet(carId, amount)` emits intent instead of mutating.
- [ ] Keep both skins and the whole DOM/CSS surface — this is a data change, not a visual one.
- [ ] Show pending state on a bet: the ER is fast but not instant, and a bet that silently does nothing is worse than a spinner.

---

## Task 5: Chain-driven phases and finish order

**Files:**
- Modify: `redline3d/src/render/race-mode.ts`

**Steps:**
- [ ] `setupRace()` takes an optional `order: number[]`; when present, rank comes from it and the `OUTCOME_NOISE` scoring is skipped entirely. `calibrateBase()` is untouched.
- [ ] Phase machine follows the chain: MARKET while `phase === 0`, COUNTDOWN + RACING on the transition to `1`, FINISH on `2`. Local `MARKET_TIME`/`marketTimer` become the fallback path only.
- [ ] Countdown from `phaseEndsTs`, not a local timer, so the render clock cannot drift from the chain's.
- [ ] Handle the race the player joined mid-flight: if `phase !== MARKET` on first poll, spectate until the next `seq` rather than showing a market that cannot be bet into.
- [ ] Handle a `seq` jump between polls (tab backgrounded) by resyncing to the current race instead of animating a stale one.

---

## Task 6: Onboarding — the first-bet path

Per the spec, `delegate_bettor` costs a one-time ~25×1s owner poll. So the shape is: **first bet is slow, every bet after is instant.** That is a UX fact to design around, not hide.

**Files:**
- Modify: `redline3d/src/chain/paddock.ts`, `redline3d/src/ui/bet-panel.ts`

**Steps:**
- [ ] `ensureBettor()`: `join` → `deposit` → `delegate_bettor`, each skipped if already done, reusing `game-session.ts`'s delegation-state classification rather than reinventing it.
- [ ] Surface the one-time delegation as explicit progress, not a frozen button.
- [ ] `claim()` after a win; the panel reads the result from `Race.history` via the `seq` on the ticket.
- [ ] Cover the 32-race claim window (`HISTORY_LEN`): a ticket older than the ring is unclaimable — say so plainly instead of failing opaquely.

---

## Task 7: Browser verification against devnet

**Files:**
- Modify: `redline3d/src/race-preview.ts`

**Steps:**
- [ ] Add a chain-mode flag to the dev harness (`race-preview.html`) that constructs the real `PaddockBook` and passes it as `book`. The harness is not in the build (`vite.config.ts:73-78`), so this ships nothing.
- [ ] Load it, place a real bet with a funded devnet wallet, watch the on-chain race, claim.
- [ ] Verify pools in the UI match `Race.pools` fetched independently, and the rendered winner matches `order[0]`.
- [ ] Only after this passes: decide whether `play/index.html` flips to chain mode. That is a separate call, not assumed here.

---

## Deferred — recorded, not forgotten

| Item | Why deferred | Blocks |
| --- | --- | --- |
| **VRF for race seeding** | `race_crank` is permissionless and the lock samples the price that seeds the winner. `LOCK_WINDOW_SECS = 2` narrows the grind to racing the honest crank inside a slot; it does not close it. `crate-roll`'s ephemeral-vrf runs on **L1** — in-ER support is unverified, so this is research with an unknown outcome. | **Mainnet.** Not devnet play. |
| **L1 rake sweep** | Designed, unbuilt. `rake_accrued` is cumulative and must never be zeroed in the ER. | House revenue, not play. |
| **`settle_pool`/`payout_of` truncation** | Ratio-bounded, unreachable at realistic supplies. No cap added, per the standing no-risk-scaffolding rule. | Nothing. |
| **`init_book` first-come** | Same posture as raider's `init_house`. Task 1 has the house win the race. | Nothing, once Task 1 runs. |

---

## Open decision for the user

**MagicBlock Forge Epoch 01** closes **2026-07-31**, theme **Mainnet**, and RPC-verified as of 2026-07-26 nothing of ours is on mainnet-beta. A mainnet paddock deploy would put real money behind the grinding hole VRF is meant to close. This plan does not assume a mainnet deploy either way — flagged because the date is fixed and the ordering consequence is real.
