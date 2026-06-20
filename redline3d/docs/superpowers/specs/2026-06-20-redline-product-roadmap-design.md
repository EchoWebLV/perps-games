# Perps Raider — Product Roadmap & MVP — master plan

**Date:** 2026-06-20
**Status:** approved-in-dialogue (4 forks locked), pending written review
**Branch:** redline-3d
**Scope:** the whole product (live-service game + synthetic-perp fintech), not a single feature.

This is a **master roadmap**, not an implementation spec. It decomposes the vision into
pillars, fixes the build order, and defines the MVP / first release. Each pillar then gets
its **own** `spec → plan → implement` cycle, linked from the table at the bottom.

---

## What we are building

A live-service arcade game for the Solana Seeker where the core loop is a **real-money
synthetic perp** on a live price feed, skinned as arcade driving. On top of that loop:
collectible coins → crates → cars-with-abilities (Pokémon-style), unlock progression, a
real-time hangout lobby, and daily engagement. The house is the counterparty (a synthetic
vault), hedged in aggregate — it is **not** a per-trade on-chain DEX.

## Locked decisions (the forks that shaped this plan)

1. **Real money in v1**, onboarded via **Privy** (embedded wallet + auth + on-ramp/KYC via
   Privy partners). No separate KYC build.
2. **Unlock-only items in v1** — crates and cars are bound to the account. **No P2P
   trading/marketplace** until a later release.
3. **Real-time shared lobby in v1** — players see each other driving in the hangout.
4. **Off-chain ledger + on-chain USDC treasury** — players deposit USDC into a treasury;
   balances and round settlement live in a fast off-chain ledger we operate; net exposure
   hedged on **FlashTrade**; withdraw USDC out. This is the **synthetic house-vault** model.

## Pillars (decomposition) and current state

| | Pillar | State today |
|---|---|---|
| A | **Core race loop** — real perp on a live feed, skinned as driving | ✅ mostly built (client-side) |
| B | **Lobby / world** — drivable hub, 3 market buildings | ✅ built (solo) |
| C | **Progression** — characters, skill trees, per-car abilities, crates, coin | 🟡 ability scaffold only |
| D | **Economy** — coin sources/sinks, crate odds, anti-inflation | ❌ |
| E | **Backend** — accounts, auth, server-authoritative balances + inventory, anti-cheat | ❌ |
| F | **Vault + real money** — off-chain ledger, USDC treasury, solvency, hedging | ❌ (SimSettlement stub) |
| G | **Marketplace** — trade/sell crates & cars | ❌ — **deferred (post-v1)** |
| H | **Live-ops** — daily bonus, seasons, retention | ❌ |

### Dependency reality (why the order is what it is)

- The instant a coin has value (C/D), the client **cannot** be trusted with balances →
  **E (server authority) is the foundation**, not a nice-to-have.
- With real money, the **RoundEngine must run server-side** (authoritative settlement). The
  client becomes a renderer. The engine is already TypeScript, so it ports cleanly.
- **F (real money)** is gated by a **jurisdiction legal read** + the vault solvency design.
  This is an owner dependency that runs in **parallel from day one**.

## Strategy: build everything on test balances, flip real money LAST

Even though real money is in v1, the entire game is built and proven on **soft/test
balances**, then real value is switched on once the vault + legal read are ready. The money
switch is the last thing flipped, not the first.

### Phased build order (within v1)

1. **Server foundation (E).** Backend skeleton, Privy auth, Postgres, server-authoritative
   coin balance + car inventory, **port RoundEngine to the server** (authoritative
   settlement on *test* money), **provably-fair crate RNG** (commit-reveal seed). Outcome:
   the existing game becomes cheat-proof with no real money yet.
2. **Economy content (C/D/H).** Crates → car drops with abilities (extend the existing
   scaffold), daily bonus, coin sink/source tuning. On soft balances.
3. **Real-time lobby (B, multiplayer).** WebSocket presence service (positions, car models,
   interpolation). Largely independent of the economy → **builds in parallel with #2**.
4. **Real money (F).** USDC treasury + deposit/withdraw via Privy, off-chain settlement
   ledger, **solvency + reconciliation + manual FlashTrade hedging** (automation post-Beta),
   flip settlement from test → real value. **Gated by the legal read.**
5. **Hardening.** Anti-cheat, multiplayer load test, vault stress test, monitoring/alerting.

## Architecture

```
┌─────────────────────────────┐         ┌──────────────────────────────────────────┐
│ CLIENT (exists)             │         │ BACKEND (new, Node/TypeScript)             │
│ Three.js / Vite / Capacitor │  REST   │  • Auth (verify Privy tokens)              │
│  • render race + lobby      │ ──────► │  • Economy/inventory service (Postgres)    │
│  • input                    │         │  • Settlement service (authoritative       │
│  • Privy SDK (wallet/auth)  │  WS     │    RoundEngine off the Pyth feed)          │
│  • renderer only for $$     │ ──────► │  • Realtime room server (lobby presence,   │
│    settlement               │         │    Colyseus + Redis)                       │
└─────────────────────────────┘         │  • Vault: off-chain ledger + USDC treasury │
                                        │    (Solana), hedged on FlashTrade          │
                                        └──────────────────────────────────────────┘
```

- **Why Node/TypeScript on the server:** it shares the `RoundEngine`, leverage math, and
  types directly with the client — one source of truth for settlement, no reimplementation.
- **Prices:** the existing Pyth Lazer→Hermes feed client, consumed **server-side** for
  authoritative settlement (the client may still render its own feed for smoothness, but the
  server's price is the one that settles).
- **Settlement = single-writer, single-instance (architecture review).** The authoritative
  RoundEngine worker runs as *one* instance (two replicas = double-settlement), driven by a
  monotonic clock, idempotent on ledger writes, crash-recoverable from durable round state in
  Postgres. A logically separate module that can be lifted to its own process without a rewrite.
- **Feed watchdog / HALT.** A frozen Pyth feed = no liquidations fire = unbounded house exposure;
  a bad tick = mass false liquidations. The settlement loop needs a tick-recency watchdog + safe-mode
  HALT and tick validation (monotonic ts, sane bounds) *before* price touches equity math (plan 1.2).
- **Realtime presence = its own deployable.** The Colyseus presence server is a separate, supervised
  small service (client auto-reconnect), never folded into the settlement process; Redis room
  sharding is deferred until load demands it.
- **Vault economics (already established, must be enforced server-side):** **linear-from-entry
  P&L** (vol-independent edge), **leverage capped (~200–500×)**, per-round exposure cap + bankroll
  floor. Real-tick replay shows the house edge holds at all leverage on normal markets; the sole tail
  risk is max leverage during a vol spike → the cap exists for exactly that. **Hedging:** Beta
  launches on these **code-only risk levers + manual** FlashTrade hedging; *automated* programmatic
  hedging (a second real-money trading bot) is deferred to **post-Beta** until volume proves the
  unhedged tail is real.

## MVP / First release — definition

The first release is a **real-money, multiplayer, unlock-progression game** — built test-first,
real value switched on at the end. In scope:

- Core race on the real feed, **server-authoritative settlement**.
- Privy sign-in + embedded wallet; **USDC deposit/withdraw**; off-chain settlement ledger.
- Single soft currency (**coin**) earned by playing; server-authoritative balance.
- **Crates** bought with coins, **provably-fair**, dropping **cars with abilities**
  (6–8 cars, each a real ability — extend the existing scaffold). **Unlock-only** (bound).
- **One daily bonus** (the single retention hook for v1).
- **Real-time shared lobby** as the home hub.

**Cut from v1 (own specs later):** characters + skill-tree abilities (cars carry the
abilities for v1), P2P trading/marketplace (G), seasons, chat/voice/emotes, car-to-car
collision.

### Release sequence

- **Alpha** — phases 1–3 complete, running on **test balances** (real game, no real money).
  Internal + closed testers. Validates fun, economy balance, multiplayer stability.
- **Beta** — phase 4: real USDC turned on for a limited cohort, small caps, vault watched
  closely. Legal read complete before this gate.
- **v1.0** — phase 5 hardening done, caps raised, public Seeker release.
- **Post-v1** — G (marketplace/trading), characters + skill trees, seasons, social.

## Risks & owner dependencies

- **Legal / jurisdiction read (owner-owned, parallel from day 1).** A real-money game where
  the house is counterparty is regulated (gambling/CFD-style rules vary by country). Privy is
  **not** a license. This gates the Beta real-money switch — nothing else blocks on it, so it
  must start immediately.
- **Vault solvency + reconciliation.** Enforced in code (linear P&L + leverage cap + exposure
  limits + bankroll floor). **Plan F adds system/treasury accounts so the books sum to zero, plus a
  continuous reconciliation drift-check that auto-halts withdrawals on mismatch** — this lives in
  plan F, not phase-5 hardening. Stress-tested before real value goes live.
- **Server-authoritative settlement refactor.** The core's biggest change; de-risked by
  porting the existing TS engine rather than rewriting.
- **Provably-fair crates.** Commit-reveal seeds, verifiable client-side — required before
  coins (let alone money) buy crates.
- **Privy scope.** Solves auth + wallet + on-ramp. Does **not** solve vault solvency,
  settlement correctness, or licensing.
- **Multiplayer scale.** Room sharding + interpolation from the start; load-tested in phase 5.

## Per-pillar spec plan (each gets its own spec → plan → implement)

| Order | Pillar spec | Depends on | Notes |
|---|---|---|---|
| 1 | Backend foundation + auth + server-authoritative balances (E) | — | unblocks everything |
| 2 | Server-side RoundEngine / settlement service (A→server) | E | test money first |
| 3 | Provably-fair crates + economy (C/D) | E | soft balances |
| 4 | Car abilities + unlock progression (C) | crates | extend scaffold |
| 5 | Real-time lobby presence (B-mp) | E | parallel with 3–4 |
| 6 | Daily bonus + live-ops (H) | E | cheap once E exists |
| 7 | Vault: USDC treasury + ledger + hedging (F) | settlement, **legal read** | flips real money on |
| 8 | Hardening: anti-cheat, load + vault stress (phase 5) | all | pre-launch gate |
| — | Marketplace/trading (G) | post-v1 | deferred |
| — | Characters + skill trees | post-v1 | deferred |

## Open questions (resolve at each pillar's own spec)

- Coin economy numbers: earn rates, crate prices, drop odds, sink/source balance.
- Exact car roster + ability designs (the Pokémon-style kit).
- Treasury custody specifics + withdrawal limits/cooldowns.
- Daily-bonus mechanic (streak? wheel? fixed?).
- Multiplayer scope detail: how many concurrent per room, what state syncs.
