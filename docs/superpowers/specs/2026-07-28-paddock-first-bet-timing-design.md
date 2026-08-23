# Paddock first-bet timing — design

**Date:** 2026-07-28
**Branch:** `paddock-race-book`
**Status:** approved, not yet planned

## The problem

A first-time player taps BET and their bet never lands.

`chainBookSource.placeBet` (redline3d/src/render/race-book-source.ts) runs the whole
chain onboarding and *then* sends the bet. Onboarding is four confirmed L1 sends
(join → wrap → deposit → delegate_bettor) followed by `pollBettorOwner(..., 25, 1000)` —
up to 25 further seconds waiting for the delegation CPI to land. The betting window is
`MARKET_SECS = 15` (onchain/raider/programs/paddock/src/state.rs:16).

Setup reliably outlives the market it started in. `place_bet` requires
`race.phase == PHASE_MARKET` (lib.rs:185), so the bet fails `WrongPhase`, which the client
maps to `MarketClosedError`.

It is worse than a failed bet. The full cycle is 61s (`MARKET 15` + `RACE 40` + `FINISH 6`),
and the panel only renders during MARKET (`showPanel = ctx.phase === "MARKET"`,
bet-panel.ts:348). `.bp-onboard` is a child of `.bp-panel`. So the player watches the
progress bar reach roughly step 3, then the entire panel — progress bar included —
disappears for 46 seconds while setup silently continues, and the red error appears about
a minute after the tap. The copy is also wrong on its face: the next market is 46s away,
not "seconds away".

## Root cause

The money and the scoreboard are on two different chains.

`deposit` (lib.rs:57-72) does two things in one instruction: an SPL transfer from the
owner's ATA into the vault, and `bettor.balance += amount`. Real tokens only exist on L1.
Once `delegate_bettor` runs, the `Bettor` account is owned by the delegation program, so
anchor's `Account<'info, Bettor>` owner check rejects the L1 write. The instruction cannot
run in the ER either, because the token accounts are not delegated and the ER cannot move
L1 tokens.

There is no chain on which both halves are reachable while delegated. This is inherent to
the ER architecture, not a defect in this program.

Raider hit the identical wall and documented it: *"A delegated ledger can't be topped up
from the wallet (`buy_in` writes the L1 copy), so a short one is quietly ended + rebuilt"*
(redline3d/src/chain/game-session.ts:274).

## Governing rule

**Never start a slow chain operation on a BET tap. Start it the moment you know it will be
needed.**

Every decision below is this rule applied twice — once to first-time funding, once to
refills.

## Design

### 1. Funding leaves the race entirely

Funding is not "take a seat at this race". It is **your balance**, exactly as on any
betting site: funded once, before the player ever reaches a race, and never touched by the
race loop again.

It lives on the `home` / `lobby` surfaces (main.ts:1000, 1211), upstream of `mode = "race"`
(main.ts:1026). Denominations: **$1 / $5 / $10 / $25**.

`ensureBettor(amount)` is called with this buy-in rather than a stake. It is already
idempotent — `reuse` short-circuits, `join` is skipped when the pair exists, `deposit`
covers only the shortfall — so it is safe to re-enter after a partial failure.

### 2. BET becomes one ER send, always

`chainBookSource.placeBet` stops calling `onboard`. `place_bet` touches only
`race` / `bettor` / `ticket`, all three delegated, so a funded bet is a single ER
transaction with no L1 round trip.

The BET gate simplifies: `canFund = ctx.wallet >= selStake || ctx.onboarding !== null`
(bet-panel.ts:359) loses its second clause. That clause existed solely to let a zero-balance
wallet tap BET and have the tap fund the account — the exact behaviour being removed. The
balance on screen becomes the whole story again. An unfunded player sees BET disabled and a
route to fund, rather than a button that looks live and then fails a minute later.

### 3. The balance refills itself, ahead of need

Copied from raider's proven pattern (`SESSION_BUFFER_BETS = 5`, game-session.ts:21):
stage several bets' worth per crossing so the heavy rebuild stays rare, and rebuild
silently rather than exposing a "top up" concept.

The trigger is the governing rule: when the balance drops below **the currently selected
stake chip** (`selStake`, bet-panel.ts:287), start the refill **immediately** — during the
race already running — not when the player next taps BET. The refill is the full
exit → deposit → re-delegate round trip (~80s undelegate poll at paddock.ts:448, plus a
fresh ~25s delegate poll), which fits inside roughly two cycles of race-and-finish dead
time.

Note the two ladders do not line up: buy-ins are $1/$5/$10/$25 and stakes are $1/$5/$20
(`STAKES`, bet-panel.ts:52). A $1 buy-in with the $20 chip selected is unfundable on
arrival, and a $10 buy-in affords a single $20 bet not at all. The funding surface must
therefore state what a buy-in actually buys at the current chip, rather than presenting the
two ladders as unrelated.

If a refill has not finished when a market opens, BET stays disabled with an honest line
and the player bets the following market. Nothing is silently lost, because nothing was
ever requested — that is the whole gain over today's behaviour.

### 4. Progress UI moves off the bet panel

Funding progress belongs on the funding surface, not inside `.bp-panel`, which is
`display:none` for 46 of every 61 seconds. The bet panel retains at most a short
"topping up" line while a refill is in flight.

### 5. Latency polish

`send()` (paddock.ts:275-282) polls `getSignatureStatuses` on a 1000ms interval. The first
check is immediate, so a fast ER commit can return promptly, but a miss costs a full
second. Tighten the poll for the bet path specifically (~150ms) so a seated bet is as
instant as the ER actually is.

## Explicitly not changing

- **The market.** Pari-mutuel, 5% rake, winners split the pool. `settlePool` /
  `payout_of` are correct and already behave exactly like virtual horse racing: stake 0.1
  into a pool where your car holds half, collect ~0.2 less rake.
- **The ER.** Races are cranked by MagicBlock's scheduler via `schedule_race_crank`
  (lib.rs:529), with no client transaction per phase. ⚠️ The scheduled task is **not
  durable** — it vanished mid-run on 2026-07-28 and left the live book dead for 13,788s —
  so an unattended book needs a staleness watchdog that re-arms it. That watchdog is unbuilt
  and is **out of scope here**, but it is a prerequisite for an unattended book and is
  arguably more urgent than this work: a stalled book takes no bets at all.
- **The program.** No Rust changes, no redeploy, no re-proving the devnet e2e.

## Error handling

- `MarketClosedError` survives as a genuine race-condition guard (a funded player tapping
  at T-0.2s). Copy corrected to reflect the real 46s gap, not "seconds away".
- Unfunded wallet: fail fast **before** spending, as raider does with
  `WalletUnfundedError` (game-session.ts:313). Sends go out `skipPreflight`, so a 0-SOL
  Privy embedded wallet otherwise dies as a silent drop plus a 60s confirm hang.
- `BettorTornError` (half-delegated pair) keeps its existing handling.

## Testing

- A funded player's bet is a single ER send — asserted by call count, not by timing.
- BET is disabled while unfunded and enables on the frame the balance covers the stake.
- Refill fires on the balance falling below one bet's worth **during RACING**, and never
  from a BET tap.
- A refill still in flight at market open leaves BET disabled with the honest line.
- Market-closed copy states the real gap.

## Prerequisite this spec assumes but does not deliver

Nothing in the shipping game builds a chain book today. The only production construction is
race-preview.ts:159, a dev harness on a dev keypair that passes no `onboard`; `main.ts`
falls through to `localBookSource()`. Wiring the chain book into the real game is a
separate piece of work that this design presupposes.

## Deferred

`race-book-source.ts` is ~650 lines carrying both the local sim and the chain book. Worth
splitting, but not as a rider on this change.
