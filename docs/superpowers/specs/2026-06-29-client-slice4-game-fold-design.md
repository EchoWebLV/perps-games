# Client Phase — Slice 4: Fold the on-chain round into the real 3D game (design)

**Date:** 2026-06-29
**Branch:** `onchain-er-rebuild`
**Status:** design — pending user review before writing-plans
**Predecessors:** Slice 1 (`2026-06-29-client-phase-slice1-onchain-round-design.md`) + Slice 3 (`2026-06-29-client-slice3-mechanics-crank-design.md`) — built the `redline3d/src/chain/` layer and proved it against the slim `onchain.html` debug UI.

## Goal

Make the **real 3D game** (`redline3d/index.html` + `src/main.ts`, the Clown-Car/throttle/track game) play on real on-chain money: route its round loop (open/flip/lever/close + crank) and its USDC play balance through the already-built `chain-round` layer, replacing the server-mark settlement path. Plus a small `delegate()` hardening so a stale/foreign delegated house fails clearly instead of with a raw runtime error.

## Context

Slices 1 + 3 built and devnet-proved the entire chain surface (`src/chain/chain-round.ts`: `buyIn`/`ensureRoundInited`/`delegate`/`open`/`flip`/`lever`/`scheduleCrank`/`close`/`forceClose`/`commitAndUndelegate`/`withdraw`/`readPlayerBalance`/`readRoundStatus`/`readRound`) and the canonical wiring idioms in `src/onchain-main.ts` (the `finalizeSettled` single-sink, the `setInterval(readRound)` crank poll, the dev-keypair wallet). `main.ts` was deliberately left untouched in those slices because its live ×/payout track a **server-mark poll** (`pollMark`/`serverMark`, `core/api.ts`, `core/round-sync.ts`) that has no on-chain analog. This slice does the fold.

**The central insight (verified):** the smooth × in `main.ts` does not actually need the server mark. The on-chain debug UI already drives a buttery × purely from the **local `RoundEngine.snapshot(price, now)`** off the live BTC feed, re-anchored at each on-chain action — the chain `readRound` poll is only a *terminal detector* (`status === 2`), never a per-frame equity source. So the fold swaps the *money + settlement spine* while leaving the feed, the engine, and the entire render/HUD/input layer intact.

## Scope (locked)

**In scope:** route `main.ts`'s round open/flip/lever/close + the USDC play balance through `chain-round`; auto-start the ER session on first GO and an explicit End/Withdraw; a crank poll + `finalizeSettled` sink in the 3D HUD; throttle→leverage wired to on-chain `lever` with instant local feel; the `delegate()` already-delegated hardening. Verified in Claude Preview on the **real game** (`index.html`).

**Out of scope (later slices / unchanged):** session keys / zero-popup signing (Slice 5); real wallet-connect (Phantom/MWA) — the dev-keypair port stays; multi-asset beyond what `open` already takes; mainnet; **and the soft-coin economy** (garage/upgrades/crates/coins via `ui/upgrades.ts`, `ui/coins.ts`) — the on-chain program has no instructions for it, so it stays exactly as it is today (separate cosmetic economy, not real money, untouched).

## Architecture

**Minimal graft, full shell kept (fold-map Approach 1).** `main.ts` keeps its structure and every screen (lobby, garage, track, car physics, tach, minimap, FX, joystick/keyboard). One module-scope `chain` handle replaces three things on the live round path — the server mark, `roundSync`, and the auth/`api.me` balance source:

```
build once:  chain = createChainRound({ wallet: portToAnchorWallet(createDevKeypairPort()), mint: TEST_USDC_MINT })

first GO  ──▶ buyIn (if needed) + delegate     (auto-start the ER session)
GO        ──▶ chain.open(dir,lev,stake) → engine.launch({entryRaw: entryHuman}) + chain.scheduleCrank()
throttle  ──▶ engine.setLeverage(niceLev, price)   INSTANT (feel)   +   chain.lever(niceLev) coalesced-to-latest (truth)
flip lane ──▶ chain.flip(laneDir) → settled? finalizeSettled : engine.setDir(laneDir, price)
cash out  ──▶ chain.close() → finalizeSettled
idle      ──▶ setInterval(readRound,650) sees status==2 (crank/time) → finalizeSettled
End       ──▶ commitAndUndelegate ;  Withdraw ──▶ chain.withdraw(balance)
frame ×   ──▶ engine.snapshot(price, now).equity  (NOT a chain read)
```

The local `RoundEngine` remains the only driver of the smooth visual ×; the on-chain `Round` is the only money truth.

## Components

### `src/main.ts` change sites (anchors approximate — pinned exactly during planning)
- **Delete the server-mark machinery:** `serverMark` state (~167), `pollMark()` (~174), the per-frame poll trigger + `const m = serverMark` consumer (~662-667), and the `serverMark = null` resets (~187, 487, 577).
- **Swap auth/balance source:** remove `createDevAuth`/`createSessionAuth` (~18-19, 79) and the live-path `api.me()` reads (~248, 284, 297, 507, 539, 562); add the `chain` handle. The cash chip's value becomes a single on-chain number: `chain.readPlayerBalance(true)` while delegated / `(false)` after End. The existing `displayCashBalance({ walletBalance, inGameBalance })` wallet/in-game split collapses for dev scope — both inputs are fed the same on-chain play balance (there is no separate server ledger anymore), so the chip shows one figure. (Soft-coin `coins` chip via `ui/coins.ts` is a different, unchanged economy.)
- **Swap GO/open** (`controls.onLaunch`, ~523-582): `roundSync.open(...)` → `await chain.open(dir, lev, stake)`; `engine.launch({ ..., entryRaw: opened.entryHuman })` (human, not raw); then `await chain.scheduleCrank()` in try/catch (degrade to a warning if the crank can't arm); first GO also runs `buyIn`+`delegate` (auto-start). Keep the existing affordability/re-entrancy guards, retargeted at the on-chain balance.
- **Swap cash-out/settle** (`settleVia`, ~475-521; `controls.onCashout`, ~584): `roundSync.close(reason)` → `await chain.close()`, routed through a new local `finalizeSettled` (below). The 60s time-cap backstop (~667) calls the same `chain.close()` (idempotent vs the crank).
- **Add the crank poll:** `setInterval(pollChain, 650)` (port of `onchain-main.ts`) — `readRound(true).status === 2` → `finalizeSettled(snap)`.
- **Wire flip/lever** (~657, ~704): `roundSync.noteFlip(laneDir)` → `await chain.flip(laneDir)` (settled-branch → `finalizeSettled`, else `engine.setDir`); the per-frame `roundSync.noteLeverage(game.lev)` → instant `engine.setLeverage` + the coalesced on-chain `lever` (below).
- **Retire `roundSync`** from the live path (`core/round-sync.ts` superseded by `chain`); its localStorage-recovery role is covered by `readRound`/`readRoundStatus` + the delegate hardening.

### `finalizeSettled(snap)` (new, local to main.ts)
Single sink for every ending — manual cash-out, terminal-first flip/lever, and the crank poll. Freezes the visual (`engine.cashout`), sets the HUD outcome/payout from `SettledRound`/`RoundSnap`, fires the existing FX (`fx.liquidate()` on outcome 2 / `fx.confetti()` otherwise), and refreshes the on-chain balance.

### Leverage model (responsive — the one accepted tradeoff)
Throttle moves `engine.setLeverage(niceLev, price)` **instantly** every step → the × and feel have zero latency (purely local). The on-chain `chain.lever(niceLev)` syncs in the background **coalesced to the latest target**: at most one tx in flight plus one pending (= the newest leverage); intermediate steps during a fast sweep are skipped. Because a fast sweep's skipped steps sit at nearly the same price, the path-dependent P&L cost is negligible. **Accepted tradeoff (user-approved):** during a rapid sweep the on-chain leverage can trail the visual by ~0.3–1s, and `close()` settles at the on-chain truth — so a fast sweep can settle a hair off the needle, the same class as the existing feed-timing drift. A divergence-free version (mirror every step) needs session keys + a per-step keeper → a later slice.

### `delegate()` hardening (the one chain-round.ts edit)
Before sending `delegateSession`, check PDA ownership (reuse the `pollOwner` predicate): if `player`/`house`/`round` are **already** owned by `DELEGATION_PROGRAM` (a stale-but-live session for this same wallet), skip the delegate tx and return clean (auto-recover). If only some are delegated (torn state) or the tx still reverts, throw a clear typed `delegate_busy`-style error the UI shows as "session busy — End your previous session, or another player holds the house; try again," instead of the raw `ExternalAccountDataModified`. No new risk-scaffolding — pure error-path clarity.

## Display / truth split

Unchanged principle from Slices 1/3: the local `RoundEngine` drives the smooth × off the live feed; the on-chain `Round` is the only money truth, surfaced via the `readRound` poll (terminal detector) and the authoritative `close()` payout. New in the 3D shell: the FX, tach, minimap-entry, and outcome badge read from the on-chain results (`opened.entryHuman`, `SettledRound.outcomeName`/`payout`) at the boundaries, but never per-frame.

## Error handling

- **Crank can't arm** (escrow underfunded) → warn in the status line; round still playable (the local 60s timeout `close()` is the backstop).
- **delegate-busy** → the clear typed error above; offer End-session to recover.
- **flip/lever returns settled** (terminal-first) → finalize exactly like a close.
- **close/withdraw RPC hiccup** (devnet 429) → the HTTP-poll confirm already retries; the `readRound` poll is the safety net for any dropped response.
- **Slice-1/3 gotchas remain in force** (HTTP-poll confirm, ownership-poll delegate/undelegate, `entryRaw·10^(-expo)`, `.accountsPartial`).

## Testing

- **Headless devnet integration** (extend the gated `chain-round.devnet.test.ts` family): a coalesced-lever sequence (rapid `lever` targets → assert only the latest lands, round stays consistent, settles correctly) + the delegate-busy path (second `delegate()` on an already-delegated session returns clean / throws the typed error, not a raw revert).
- **Claude Preview on the real game** (`index.html`, per the verify-in-browser rule): fund the shown wallet, drive → first GO (auto buy-in+delegate, crank armed) → flip lanes → sweep the throttle and watch leverage track → cash out; then a **hands-off round the crank auto-settles**; then End session + Withdraw. Capture the settled HUD.

## Decisions / defaults

- Minimal graft across the **full** game shell (lobby/garage/track all kept); only the round money spine + play balance move on-chain.
- Leverage = instant local + **coalesce-to-latest** on-chain `lever`; the small settle-time divergence is accepted.
- Session = **auto buy-in+delegate on first GO**, explicit **End**/**Withdraw**.
- **Crank settles first; the 60s local timeout is an idempotent fallback** `close()`.
- **Keep `onchain.html`** as the debug entry (free safety net during the fold).
- The **soft-coin economy stays unchanged** (no on-chain instructions for it).
- `delegate()` hardening is error-path clarity only — no new caps/throttles. RMAX=2000 untouched.

## Carry-forward (tracked, not in this slice)

- Session keys → zero-popup signing + a per-step lever keeper that removes the leverage divergence.
- Real wallet-connect (Phantom/web Wallet Standard, MWA/Seed Vault on Seeker) replacing the dev-keypair port.
- Putting the soft-coin economy (crates/upgrades) on-chain (new program instructions) — separate, much larger slice.
- The pre-mainnet program hardening bundle (`snap.price > 0` on flip/lever; `feedauth.ts` negatives for force_close/tick_crank); crank-escrow sponsorship/iteration sizing → economics.
