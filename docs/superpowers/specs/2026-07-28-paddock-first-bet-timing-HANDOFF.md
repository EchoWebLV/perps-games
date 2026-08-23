# HANDOFF — paddock first-bet timing

**Date:** 2026-07-28
**Design spec:** `docs/superpowers/specs/2026-07-28-paddock-first-bet-timing-design.md`
**Status:** design approved by the user. Nothing built. Nothing committed.

---

## 0. Read this first — where the code actually is

The paddock program and its client live on branch **`paddock-race-book`**, in the **main
checkout** at `/Users/yordanlasonov/Documents/GitHub/perps-games`.

They are **not** in the `claude/eloquent-blackburn-55b2b1` worktree where this design was
done. If you `find` for `paddock/src/state.rs` and get nothing, you are in the wrong tree.

Both the spec and this handoff were written into the main checkout, on that branch, and are
**uncommitted**.

---

## 1. The problem

A first-time player taps BET and the bet never lands.

`chainBookSource.placeBet` (redline3d/src/render/race-book-source.ts:505) runs the full chain
onboarding and *then* sends the bet. Onboarding is four confirmed L1 sends
(join → wrap → deposit → delegate_bettor) plus `pollBettorOwner(DELEGATION_PROGRAM,
"delegate_bettor", 25, 1000)` — up to 25 further seconds. The betting window is 15 seconds.

`place_bet` requires `race.phase == PHASE_MARKET` (lib.rs:185), so the late bet fails
`WrongPhase` → `MarketClosedError` (paddock.ts:410).

**It is worse than a failed bet.** The cycle is 61s (MARKET 15 + RACE 40 + FINISH 6), and the
panel only renders during MARKET (`showPanel = ctx.phase === "MARKET"`, bet-panel.ts:348).
`.bp-onboard` is a child of `.bp-panel`. So the progress bar reaches ~step 3, the whole panel
vanishes for 46 seconds while setup silently continues, and the red error lands about a
minute after the tap. The copy is wrong too — the next market is 46s away, not "seconds".

---

## 2. Root cause (verified, do not re-derive)

**The money and the scoreboard are on different chains.**

`deposit` (lib.rs:57-72) does two things in one instruction: an SPL transfer owner ATA →
vault, and `bettor.balance += amount`. Real tokens only exist on L1. Once `delegate_bettor`
runs, the `Bettor` account is owned by the delegation program, so anchor's
`Account<'info, Bettor>` owner check (lib.rs:625) rejects the L1 write. It cannot run in the
ER either — the token accounts are not delegated and the ER cannot move L1 tokens.

No chain has both halves reachable while delegated. **This is inherent to the ER
architecture, not a defect in this program.**

Raider hit the identical wall and says so in a comment:
> *"A delegated ledger can't be topped up from the wallet (`buy_in` writes the L1 copy), so a
> short one is quietly ended + rebuilt"* — redline3d/src/chain/game-session.ts:274

---

## 3. Decisions the user made

| Question | Decision |
|---|---|
| Fix approach | **Explicit funding before betting.** Not intent-carrying, not copy-only. |
| Keep the ER? | **Yes.** "we are using the er... should be pretty much instant" |
| Buy-in denominations | **$1 / $5 / $10 / $25** |
| Build a top-up button? | **No.** Copy raider's silent background refill. |
| Framing | **"Your balance", not "take a seat".** The user pushed back hard on inventing a seating ceremony — their words: *"its like prediction market… just make it like how the virtual horses work"* and *"i bet directly from my wallet"*. Funding is a betting-account balance, funded once at the door, and the race loop never touches it. |

**Governing rule the whole design hangs on:**
> Never start a slow chain operation on a BET tap. Start it the moment you know it will be
> needed.

---

## 4. Architecture verdict — the user asked "are we forcing the ER?"

Answered honestly, and the answer was **partly yes**. Carry this forward; don't re-litigate.

**What the ER genuinely earns — one thing, and it is weaker than it first looks:**
`RaceCrank` (lib.rs:734) has **no signer at all**, and `schedule_race_crank` (lib.rs:529)
registers it with MagicBlock's scheduler, so the validator fires it with no client
transaction. Solana has no native scheduler, so on L1 you would sign every phase change
yourself.

⚠️ **But the scheduled task is NOT durable.** On **2026-07-28** the live wSOL book was found
dead — stalled at seq 136 in MARKET, **13,788s past its deadline** — with the scheduled task
simply gone, despite being armed for 1,000,000 iterations it had not exhausted (the feed was
fresh, so this was not a `StalePrice` stall). Re-arming step 4 of
`onchain/raider/scripts/paddock-house-setup.mjs` revived it → seq 179+.

**Nothing on chain records that a task exists** — `magicblock-magic-program-api` 0.10.1 has
no readable task PDA, so the only detection is behavioural: watch `phase_ends_ts` go overdue.
**This watchdog is UNBUILT.** An unattended book silently stops taking bets.

So the honest delta is **"light watchdog that polls and re-arms" vs "full keeper that signs
every phase change"** — roughly 3 signed transactions per 61s cycle on L1, versus a staleness
poll on the ER. That is still a real advantage, but it is *not* "no keeper needed", and any
claim that races are fully self-running is now known to be false.

**What it half-earns:** live odds (ER near-instant vs ~2–4s L1 lag in a 15s window), instant
bets (nice, not load-bearing), fees (~$0.001/bet at $1 stakes — irrelevant).

**What it costs:** the whole funding bridge, no top-up while delegated, torn account pairs,
validator pinning, stale ER clones after undelegate, and a 32-race claim ring where winnings
can silently expire.

**Verdict:** nothing in paddock needs sub-second finality. Raider (perps, leverage, price
feeds) is where the ER obviously earns its keep. As a standalone product, L1 + a keeper would
be simpler and better for paddock. It is kept for (a) a lighter liveness burden than L1 —
watchdog rather than keeper, now that the crank is known to be non-durable — and (b) MagicBlock
Forge Epoch 01, which closes **2026-07-31** and for which the ER is the thesis of the entry.
This is a reversible decision after the deadline — the market logic is chain-agnostic.

**Note for whoever picks this up:** the watchdog is a real, unbuilt prerequisite for an
unattended book, and it is independent of the first-bet work in this handoff. It is arguably
more urgent: a stalled book takes no bets at all.

**The forcing was never the ER. It was putting the bridge crossing inside the 15-second
window.**

---

## 5. The design, in five points

Full detail in the spec. Summary:

1. **Funding leaves the race entirely.** It lives on `home` / `lobby` (main.ts:1000, 1211),
   upstream of `mode = "race"` (main.ts:1026). `ensureBettor(amount)` takes a buy-in, not a
   stake. It is already idempotent (`reuse` short-circuit; `join` skipped when the pair
   exists; `deposit` covers only the shortfall), so re-entry after partial failure is safe.
2. **BET becomes one ER send, always.** `place_bet` touches only race/bettor/ticket, all
   delegated. `chainBookSource.placeBet` stops calling `onboard`.
3. **`canFund` loses its second clause.** `ctx.wallet >= selStake || ctx.onboarding !== null`
   (bet-panel.ts:359) — that clause existed *only* to let a zero-balance wallet tap BET and
   have the tap fund the account, which is the behaviour being removed.
4. **The balance refills itself ahead of need.** Raider's pattern (`SESSION_BUFFER_BETS = 5`,
   game-session.ts:21). Trigger when balance drops below the selected stake chip — start it
   **during the race already running**, never on a tap. The refill is the full
   exit → deposit → re-delegate round trip (~80s undelegate poll at paddock.ts:448 plus a
   fresh ~25s delegate poll), which fits inside ~2 cycles of race-and-finish dead time.
5. **Progress UI moves off `.bp-panel`**, which is `display:none` for 46 of every 61 seconds.

**Not changing:** the pari-mutuel market (pool, 5% rake, winners split — already exactly
virtual-horse behaviour), the ER, or the Rust. No redeploy, no re-proving the devnet e2e.

---

## 6. Open items — resolve before or during planning

1. **The two ladders don't align.** Buy-ins are $1/$5/$10/$25; stakes are $1/$5/$20
   (`STAKES`, bet-panel.ts:52). A $1 buy-in with the $20 chip selected cannot bet at all.
   Either align the numbers or make the funding screen state what a buy-in buys. **User has
   not chosen.**
2. **Default buy-in chip was never settled.** The question was asked and overtaken by the
   architecture discussion.
3. **A better refill may exist, unproven.** The design copies raider's silent
   exit → deposit → re-delegate rebuild (~105s), because that is the pattern already proven
   on devnet. But an earlier paddock design note records a second candidate: **an L1
   pending-deposit account that the crank sweeps in-rollup.** If that works, the round trip
   disappears entirely and refills become near-instant. It needs a spike to confirm the ER
   can see the L1 account, and it is a program change (so: redeploy + re-prove the e2e).
   Worth evaluating before committing to the rebuild path, but not before the Forge deadline.
4. **PREREQUISITE, not delivered by this spec:** nothing in the shipping game builds a chain
   book. The only production construction is race-preview.ts:159 — a dev harness on a dev
   keypair that passes no `onboard`. `main.ts` has no paddock reference at all, and race-mode
   falls through to `localBookSource()` (race-mode.ts:257-258). **Wiring the real game to the
   chain is separate work this design presupposes.**

---

## 7. Verified reference — facts already established, don't re-check

| Fact | Location |
|---|---|
| `MARKET_SECS=15`, `RACE_SECS=40`, `FINISH_SECS=6` → 61s cycle, next market 46s after lock | state.rs:16-18 |
| `place_bet` requires `PHASE_MARKET` | lib.rs:185 |
| `WrongPhase` → `MarketClosedError`, copy says "seconds away" (wrong) | paddock.ts:410 |
| `deposit` = SPL transfer + `bettor.balance` write | lib.rs:57-72 |
| `Deposit.bettor` is `Account<'info, Bettor>` → anchor owner check blocks it when delegated | lib.rs:625 |
| `send()` polls `getSignatureStatuses` at 1000ms × 60; first check immediate | paddock.ts:275-282 |
| `ONBOARD_STEPS = [join, wrap, deposit, delegate, confirm]` | race-book-source.ts:67 |
| Panel renders only in MARKET; `.bp-onboard` is inside `.bp-panel` | bet-panel.ts:246, 348 |
| `STAKES = [1,5,20]`, `selStake` defaults to 5 | bet-panel.ts:52, 287 |
| Crank permutes `entrants` **and** `strengths` together — same 8 cars, never redrawn | lib.rs:310-315 |
| Slot resolved at tap time, before the await (would break any carried-intent design) | race-book-source.ts:505 |
| `RaceCrank` has no `Signer` — fully permissionless | lib.rs:734-740 |
| `schedule_race_crank` uses `MagicBlockInstruction::ScheduleTask` | lib.rs:529 |
| ⚠️ Scheduled task is NOT durable — vanished mid-run 2026-07-28, book dead 13,788s; no readable task PDA, detection is behavioural only; watchdog UNBUILT | see §4 |
| Cash-out undelegate poll: `pollBettorOwner(PADDOCK, "exit_bettor", 40, 2000)` → ~80s | paddock.ts:448 |
| Raider buffer + silent rebuild + `WalletUnfundedError` for 0-SOL Privy wallets | game-session.ts:21, 274, 313 |
| Claim ring is 32 races; winnings silently expire past it | `HISTORY_LEN`, state.rs |

---

## 8. Suggested next step

Read the design spec, resolve the two open number questions with the user, then produce an
implementation plan. Do **not** start building — the user's standing rule is no unrequested
scaffolding, and the prerequisite in §6.4 means this cannot ship standalone anyway.

Separately, flag the **crank watchdog** (§4) to the user as its own piece of work. It is
unrelated to first-bet timing and probably more urgent.
