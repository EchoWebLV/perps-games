# Minefield — Design Spec (MVP)

**Date:** 2026-06-15
**Status:** Draft for review
**Author:** Brainstormed with Claude

---

## 1. One-liner

A mobile-first Mines game where every tile you flip is a real-price perp leg. Gems compound your multiplier parlay-style; a mine liquidates your run; cash out anytime. $1 stakes, provably-real outcomes, run as a hedged house vault that hedges on FlashTrade (Solana).

## 2. Background & competitive context

Research (28 sources, 25 claims adversarially verified) established:

- **Banana Zone** ([bananazone.app](https://www.bananazone.app/)) is a *live* Solana product — "Arcade Finance / the arcade for degens" — doing **solo directional price prediction**. A frontend + API + on-chain teardown (2026-06-15, high confidence) shows it is **synthetic, not real perps**: a "live trade" is a ~5-second binary up/down bet paid at fixed, volatility-derived odds (capped ~6x) against a **house treasury vault** (LP-fundable), with MagicBlock ephemeral rollups + a TEE attestation providing on-chain settlement over a *centralized* price/odds backend. No perp primitives (margin/leverage/liquidation/funding/PnL), no perp-protocol SDK. It owns the solo-prediction format.
- **Stake-style Crash/Mines** are the most addictive crypto-casino mechanics. **Mines is structurally a parlay**: a chain of all-or-nothing legs with a compounding multiplier and a cash-out button.
- **The white space** Banana Zone/Rollbit leave open is *not* solo prediction — it's a different, more game-like format.

**Our wedge (sharpened by the teardown):** Banana Zone is already a synthetic house-vault — *the same economic core we chose* — so we do **not** compete on "real vs fake perps." We win **within the house-vault category** on: (1) the **Mines/parlay format** (richer/stickier than their flat 5s up/down, ≤6x); (2) **transparency** of odds + house edge (vs trade-like copy over a fixed-odds bet); (3) **provable fairness** via on-chain commit-reveal + a directly-read signed oracle (vs an opaque odds grid + TEE-attested off-chain engine); (4) **genuine on-chain escrow** (vs a custodial "platform wallet"). Bonus: their **LP-funded treasury** is a viable way to bootstrap the vault bankroll.

**Key finance fact that shaped the design:** parallel real perp positions *add* (portfolio PnL is linear); only sequential "let it ride" compounding *multiplies*. Mines is sequential by nature, so it maps cleanly onto a true compounding parlay. A clean fixed-odds multiplier on a $1 stake requires a **synthetic** (house-settled) bet rather than literal positions — hence the house-vault model.

## 3. Goals & non-goals

### Goals (MVP)
1. A genuinely fun, snappy, one-thumb mobile Minefield game.
2. Real money, $1 stakes, instant tile resolution.
3. **Provably-real** outcomes anchored to live market prices + commit-reveal fairness.
4. A **hedged house vault** with conservative launch guardrails that survives a small (<$10k) bankroll.
5. Genuine FlashTrade usage: price truth + hedging the vault's net exposure.
6. Ship safely: geofencing + limited beta from day one.

### Non-goals (deferred past MVP)
- Leaderboards, streaks/quests, seasons/points, referrals, social share cards.
- Automated/continuous hedging optimization (MVP hedging can be threshold-triggered / semi-manual).
- A "real-positions hard mode" (literal FlashTrade positions per run).
- Pyramid cross-margin vault, multi-leg synthetic parlay card, a token.
- Native mobile apps (PWA only).

## 4. Core game design

### Board & rules
- Grid of **N = 25** tiles (5×5). Player picks **m** mines (e.g., 1–5; more mines = steeper multiplier, higher bust chance).
- Player sets **stake** (launch range **$0.25–$2**).
- Flip tiles one at a time. Each flip resolves to **gem** (leg won → multiplier ratchets up) or **mine** (leg liquidated → run over, stake lost).
- **Cash out** anytime to bank `stake × currentMultiplier`.

### Multiplier schedule (Stake-derived, with our edge)
After `k` gems revealed on `N` tiles with `m` mines:

```
fairMultiplier(k) = Π_{i=0}^{k-1} (N - i) / (N - m - i)
payoutMultiplier(k) = fairMultiplier(k) × (1 - houseEdge)
```

- `houseEdge` = **~5%** at launch (tunable).
- **Effective multiplier cap = `min(globalCap, maxPayout / stake)`**, with launch `globalCap ≈ ×50` (see §6). So a $1 stake can reach ×50 (→ $50), while a $2 stake is capped at ×25 to respect the same $50 max payout.

## 5. The provably-real resolver (core novelty — needs security review)

This is the existential module: it must be **fun (real-price-driven)** AND **exploit-proof** AND **verifiable**.

### Commit-reveal frame (both schemes)
- Per run, backend generates `serverSeed` (32 bytes), publishes `commit = SHA256(serverSeed)` **before** any flip.
- Player has a `clientSeed`; each flip has an incrementing `nonce`.
- After the run, `serverSeed` is revealed; the client "Verify" page replays the run deterministically.

### Recommended MVP scheme — "B′: sealed future window"
Each flipped tile resolves against **real price movement**, but the player has *no actionable information*:
- On flip, the tile is assigned a **direction (long/short) and threshold**, both **derived from `HMAC(serverSeed, clientSeed:nonce)` and hidden until resolution**.
- The tile resolves over a **short future window** `[t_flip + δ, t_flip + δ + Δ]` against the **Pyth** price for the run's asset.
- **Gem** if the real price move satisfies the hidden predicate; **mine** otherwise (calibrated so P(win) matches the schedule's implied odds).
- **Volatility-adaptive thresholds:** the threshold is set from current realized volatility so P(win) stays constant regardless of *when* the player flips — removing any timing/latency edge. Because direction is hidden and random, observing a trend gives the player no advantage.

**Why it resists exploits:** hidden seed-derived direction + a future window + vol-adaptive thresholds mean the player can't time flips for positive EV, and the operator can't cheat (predicate committed via `serverSeed`, resolved on public Pyth prices).

### Conservative fallback — "A: provably-fair + market entropy"
If B′'s vol-calibration proves too risky for launch: classic provably-fair Mines (`HMAC` mine layout) seeded with an **unpredictable public beacon** (a future Solana blockhash + Pyth snapshot) so neither side can predict outcomes; "real" connection = odds calibrated to live volatility + market-sourced entropy. Less "real-perp," maximally safe.

> **Open decision:** B′ vs A is the #1 thing to resolve in a dedicated resolver+security design pass before mainnet. Beta launches behind low caps specifically to validate this.

## 6. House economics & vault guardrails

- **Edge** (~5%) baked into the multiplier schedule = revenue.
- **Anti-ruin: max single payout ≤ ~1% of vault** (≈ $50 on a $5k vault). This caps `stake × multiplier`.
- **Launch guardrails (scale with bankroll):** stakes $0.25–$2; multiplier cap ≈ ×50; per-user daily loss/exposure limits; global daily max-exposure cap.
- **Hedging:** when the vault's *net directional exposure* (aggregated across live runs, by asset) exceeds a threshold, open an offsetting **real FlashTrade position** via `flash-sdk`. MVP hedging may be threshold-triggered and coarse; refine later.
- **Bankroll growth:** guardrails ratchet up automatically as the vault grows from accumulated edge.
- **Per-round expectation:** the house pays out on the *majority* of rounds (small cash-outs) and wins on busts (full stake); net positive by the edge over volume — not per round.

## 7. System architecture (4 layers)

1. **Mobile PWA (client)** — Minefield UI, wallet/auth, the "Verify round" page. Installable, one-thumb.
2. **Game Backend (off-chain, fast)** — Provably-Real Resolver, Odds & Multiplier Engine, Round State machine, Ledger/balances. Off-chain for snappy $1 play; authoritative for gameplay, settles to chain.
3. **Price truth — Pyth** — Pyth (Lazer) feeds for SOL/BTC/ETH drive tile outcomes + odds; publicly attestable = fairness anchor.
4. **On-chain (Solana)** — **Vault Program** (Anchor): USDC custody, deposits/withdrawals, signed settlement of net run results, bankroll accounting. **FlashTrade hedge** via `flash-sdk`.

### Module boundaries (each independently testable)
- `resolver` — pure function: `(serverSeed, clientSeed, nonce, pythWindow, riskConfig) → gem|mine`. No I/O; deterministic; the heart of verifiability.
- `odds-engine` — `(riskConfig, volatility) → multiplier schedule + thresholds`.
- `round-state` — run lifecycle FSM: `created → committed → playing → (cashed_out | busted) → settled`.
- `ledger` — balances, idempotent debits/credits, history.
- `vault-program` — on-chain custody + settlement instruction(s).
- `hedger` — watches net exposure, places/cancels FlashTrade hedges.
- `wallet/auth` — embedded wallet + adapter + session.
- `compliance` — geofencing, allowlist, limits.

## 8. Data model & money flow

- **Deposit:** user sends USDC to the Vault Program → off-chain balance credited (idempotent, keyed on tx sig).
- **Play:** stake debited from off-chain balance at run start; resolver/odds drive the run; cash-out credits `stake × multiplier`; bust credits nothing. All ledger entries idempotent and tied to a `runId`.
- **Settlement:** net vault P&L per run recorded; periodic/triggered on-chain settlement reconciles off-chain ledger with the Vault Program.
- **Withdraw:** user requests → on-chain transfer from Vault Program to user wallet (subject to compliance checks / KYC threshold).
- **Hedge:** independent of user funds; vault opens/closes FlashTrade positions to manage net book.

**Core entities:** `User`, `Wallet`, `Deposit`, `Balance`, `Run` (commit, clientSeed, riskConfig, asset, flips[], state, multiplier, payout), `Flip` (nonce, pythWindowRef, outcome), `LedgerEntry`, `Withdrawal`, `HedgePosition`, `VaultState`.

## 9. On-chain Vault Program (Anchor)

- Accounts: `VaultState` (bankroll, caps, authority), per-user `UserAccount` (deposited balance, withdrawable), config.
- Instructions: `initialize`, `deposit`, `requestWithdraw`/`withdraw`, `settleRun` (authority-signed net result, with on-chain sanity caps), `updateConfig`.
- **Trust posture:** gameplay is off-chain for speed; the chain is the **custody + settlement + audit** layer. Settlement instructions enforce the max-payout cap on-chain as a backstop against a compromised backend. Verifiability of *fairness* is provided by commit-reveal + public Pyth data, independent of the chain.

## 10. FlashTrade & Pyth integration

- **Package:** `flash-sdk` (npm; NOT `@flash-trade/flash-sdk`), `PerpetualsClient`.
- **Hedging:** `openPosition` / `closePosition` / `decreaseSize` / `placeTriggerOrder`; use **SOL/BTC/ETH Crypto pool only** (~10.2 bps round-trip; avoid FX/metals/meme pools). Quote fees pre-trade via `getOpenPositionQuote` / `getEntryPriceAndFeeSyncV2`.
- **Price:** Pyth (Lazer) reads for outcomes + odds (`getMinAndMaxOraclePriceSync` or Pyth feeds directly).
- **Constraints honored:** ~$10 min real-position size and ~1s mainnet confirmation only affect **hedging granularity**, not user-facing $1 play (which is synthetic/off-chain).

## 11. Wallet & auth

- **Embedded wallet** (Privy-style email/social, no seed phrase) for frictionless onboarding + **Solana wallet adapter** (Phantom/Backpack) for power users.
- USDC as the unit of account. Session management for off-chain play.

## 12. Trust, safety & compliance (MVP-critical)

- **Geofencing** of restricted jurisdictions from day one.
- **Limited beta:** allowlist + low caps to validate the resolver against exploits before public launch.
- **KYC** on withdrawals above a threshold; sanctions screening.
- **Responsible gaming:** per-user deposit/loss/session limits, self-exclusion, clear odds/edge disclosure.
- **Provably-real verification** page so users can independently check any run.
- **Legal review before mainnet launch** — real-money + house-banked + leverage-flavored = gambling/derivatives exposure. Treated as a launch gate, not an afterthought.

## 13. Error handling & edge cases

- **Pyth gap/staleness during a flip window:** void the flip (no stake change), re-roll window, or pause the run; never resolve on stale/again-publishable data.
- **Backend crash mid-run:** run state is durable + resumable from `round-state` FSM; commit already published so fairness is preserved.
- **Double-spend / replay:** all ledger ops idempotent (keyed on `runId`/`flipId`/tx sig).
- **Withdrawal while runs in-flight:** only `withdrawable` (non-staked) balance is withdrawable.
- **Vault near a cap:** reject new runs whose max payout would breach the per-round or aggregate cap.
- **Hedge failure (Flash tx fails/slow):** retry with backoff; if exposure can't be hedged, tighten new-run acceptance until back within limits.
- **Clock/latency:** server is the timekeeper; flips stamped server-side; client times are advisory.

## 14. Testing strategy

- **Resolver:** property-based + golden-vector tests proving determinism and that published `(commit, serverSeed, clientSeed, nonce, pythWindow)` always reproduce outcomes; an independent re-implementation of the verifier.
- **Exploit/EV simulation:** Monte-Carlo bot players (momentum-timers, latency-arbers) confirming no flip-timing strategy yields positive EV; long-run house P&L converges to the edge.
- **Economics sim:** verify max-payout caps prevent ruin across volatility regimes and bankroll sizes; confirm aggregate house EV = edge.
- **Vault program:** Anchor tests for deposit/withdraw/settle, the on-chain payout-cap backstop, and authority misuse.
- **Hedger:** simulated exposure → asserts correct FlashTrade hedge sizing/cancellation.
- **End-to-end:** deposit → play → cash-out/bust → settle → withdraw on devnet.
- **Compliance:** geofence + limit enforcement tests.

## 15. Tech stack (proposed)

- **Frontend:** React + PWA (installable, offline shell), TypeScript.
- **Backend:** TypeScript (Node) services; durable round-state store (Postgres) + fast cache (Redis); WebSocket for live game.
- **Chain:** Solana, Anchor (Rust) for the Vault Program; `flash-sdk` + Pyth for hedging/prices; Privy + Solana wallet-adapter.

## 16. MVP cut & phasing

- **MVP:** wallet + USDC deposit → Minefield with the provably-real resolver → cash-out/settlement with launch guardrails → withdraw → Verify-round page → geofencing + limited beta.
- **Phase 2:** leaderboards, streaks/quests, referrals, social share cards, automated hedging.
- **Phase 3:** real-positions hard mode, pyramid/synthetic multi-leg parlay card, seasons/token.

## 17. Open questions / risks (ranked)

1. **Resolver scheme (B′ vs A)** and its exploit-resistance — existential; needs a dedicated security design pass before mainnet.
2. **Regulatory classification** by target jurisdiction — gates launch; legal review required.
3. **Vol-adaptive threshold calibration** keeping house edge stable across regimes.
4. **Custody/settlement trust model** — degree of on-chain enforcement vs off-chain speed.
5. **Minimum viable bankroll** vs desired stakes/multiplier caps.
6. **MagicBlock ephemeral-rollup** production status (upside for any future real-position mode; not on MVP path).

## 18. Key references

- FlashTrade docs: position model, fees, liquidation, limit-orders; `flash-sdk` TypeDoc; `flash-perpetuals` on-chain program.
- Pyth Lazer + MagicBlock (speed/oracle).
- Stake provably-fair calculation (HMAC-SHA256; Mines/Limbo math).
- PancakeSwap Prediction (round/phase + parimutuel), Rollbit (1000x UX), Hyperliquid points (retention) — references for Phase 2+.
- Banana Zone (live competitor / closest precedent).
- Columbia Law "Gamblification of Finance" — dark patterns to design *around*.
