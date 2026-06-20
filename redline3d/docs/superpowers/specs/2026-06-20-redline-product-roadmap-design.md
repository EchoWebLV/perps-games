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
2. **Soft-coin economy in v1; real value flips last.** The lobby is a player economy hub —
   buy / sell / trade cars, buy upgrades, buy crates — all denominated in the **soft coin**.
   Items are account-bound re: *real value*: **no real-money item cash-out / P2P real-value
   market** until the same legal gate as F. (Evolves the earlier "unlock-only, no trading in
   v1" call — trading IS in v1, just in soft coins.)
3. **Lobby = async economy hub (not a market selector).** Drive up to functional buildings:
   **Garage** (your cars + marketplace), **Upgrades** (the existing upgrade tree), **Crate
   Shop**, and a **Track gate** (drive in → pick SOL/BTC/ETH → race). Kept "alive" without
   netcode via **async showroom presence** (real players' parked / for-sale cars + bots).
   **Real-time avatars (Colyseus) are deferred to post-v1** — an empty real-time room reads as
   a dead game at launch.
4. **Off-chain ledger + on-chain USDC treasury** — players deposit USDC into a treasury;
   balances and round settlement live in a fast off-chain ledger we operate; net exposure
   hedged on **FlashTrade**; withdraw USDC out. This is the **synthetic house-vault** model.

## Pillars (decomposition) and current state

| | Pillar | State today |
|---|---|---|
| A | **Core race loop** — real perp on a live feed, skinned as driving | ✅ mostly built (client-side) |
| B | **Lobby / economy hub** — Garage+marketplace, Upgrades, Crate Shop, Track gate | 🟡 3-market version built; being repurposed |
| C | **Progression** — characters, skill trees, per-car abilities, crates, coin | 🟡 ability scaffold only |
| D | **Economy** — coin sources/sinks, crate odds, anti-inflation | ❌ |
| E | **Backend** — accounts, auth, server-authoritative balances + inventory, anti-cheat | ❌ |
| F | **Vault + real money** — off-chain ledger, USDC treasury, solvency, hedging | ❌ (SimSettlement stub) |
| G | **Marketplace** — buy/sell/trade cars & crates | 🟡 **soft-coin market in v1**; real-money item cash-out post-v1 |
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
3. **Lobby economy hub (B) + async presence.** Repurpose the lobby into the economy town
   (Garage+marketplace, Upgrades, Crate Shop, Track gate) wired to the ledger/inventory;
   showroom presence via async REST (parked / for-sale cars + bots), **no Colyseus in v1**.
   Real-time avatars are a post-v1 add.
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

## Lobby — the economy hub

The lobby is the **town**: a drivable space whose buildings *are* the economy. It replaces the
original 3 market-select buildings (SOL/BTC/ETH).

**Navigation flow:** the game **launches straight into the Track** — the race is home, so players
land in the core loop with no menu friction. You **drive to the Lobby** (map/garage button) to
manage your car & economy, then take the **Track gate** back out to a race (picking the market on
the way). The lobby is a *side-trip for the economy*, not the front door. (This matches today's
client: it boots into the race; the map button opens the lobby.)

- 🏠 **Garage** — your car collection + the **marketplace** (browse/buy cars in soft coins; sell
  later). Doubles as showroom — other players' cars + "for sale" tags populate the world.
- 🔧 **Upgrades** — buy upgrades from the **existing upgrade tree** ([`ui/upgrades.ts`](../../../src/ui/upgrades.ts),
  which already tunes LIQ/MAXSEC/RMAX). Spent in soft coins.
- 📦 **Crate Shop** — spend coins on **provably-fair** crates → cars with abilities.
- 🏁 **Track gate** — drive in → pick **SOL / BTC / ETH** → launch the race. Market selection
  lives here now (previously the 3 buildings).

Everything is **server-authoritative** (marketplace prices, what you own, what a crate drops)
and **soft-coin** denominated in v1. **Presence is async** (parked/for-sale cars, bots) —
real-time avatars are post-v1. This supersedes the 3-market lobby in
`specs/2026-06-19-garage-lobby-design.md`: the drive-into-a-building interaction model carries
over; the buildings' purpose changes.

## MVP / First release — definition

The first release is a **real-money, multiplayer, unlock-progression game** — built test-first,
real value switched on at the end. In scope:

- Core race on the real feed, **server-authoritative settlement**.
- Privy sign-in + embedded wallet; **USDC deposit/withdraw**; off-chain settlement ledger.
- Single soft currency (**coin**) earned by playing; server-authoritative balance.
- **Crates** bought with coins, **provably-fair**, dropping **cars with abilities**
  (6–8 cars, each a real ability — extend the existing scaffold). **Unlock-only** (bound).
- **One daily bonus** (the single retention hook for v1).
- **Lobby economy hub** — Garage+marketplace, Upgrades, Crate Shop, Track gate; soft-coin
  buy/sell/trade; async showroom presence (no real-time netcode in v1).

**Cut from v1 (own specs later):** characters + skill-tree abilities (cars carry the
abilities for v1), **real-time avatar netcode (Colyseus)**, **real-money item cash-out**,
seasons, chat/voice/emotes, car-to-car collision.

### Release sequence

- **Alpha** — phases 1–3 complete, running on **test balances** (real game, no real money).
  Internal + closed testers. Validates fun, the economy/marketplace loop, and crate balance.
- **Beta** — phase 4: real USDC turned on for a limited cohort, small caps, vault watched
  closely. Legal read complete before this gate.
- **v1.0** — phase 5 hardening done, caps raised, public Seeker release.
- **Post-v1** — real-money item cash-out, real-time avatars, characters + skill trees, seasons, social.

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
- **Empty-lobby cold start.** At launch the world is near-empty; defeat the "dead game" look
  with **async showroom presence** (real players' parked / for-sale cars + a few bots) and by
  concentrating who's online — *not* with real-time netcode. Real-time avatars (+ Redis room
  sharding) come post-v1, once population justifies them.

## Per-pillar spec plan (each gets its own spec → plan → implement)

| Order | Pillar spec | Depends on | Notes |
|---|---|---|---|
| 1 | Backend foundation + auth + server-authoritative balances (E) | — | unblocks everything |
| 2 | Server-side RoundEngine / settlement service (A→server) | E | test money first |
| 3 | Provably-fair crates + economy (C/D) | E | soft balances |
| 4 | Car abilities + unlock progression (C) | crates | extend scaffold |
| 5 | Lobby economy hub + soft-coin marketplace (B/G) | E, crates | the town: Garage/Upgrades/Crates/Track |
| 6 | Daily bonus + live-ops (H) | E | cheap once E exists |
| 7 | Vault: USDC treasury + ledger + hedging (F) | settlement, **legal read** | flips real money on |
| 8 | Hardening: anti-cheat, load + vault stress (phase 5) | all | pre-launch gate |
| — | Real-money item cash-out + real-time avatars | post-v1 | deferred |
| — | Characters + skill trees | post-v1 | deferred |

## Open questions (resolve at each pillar's own spec)

- Coin economy numbers: earn rates, crate prices, drop odds, sink/source balance.
- Exact car roster + ability designs (the Pokémon-style kit).
- Treasury custody specifics + withdrawal limits/cooldowns.
- Daily-bonus mechanic (streak? wheel? fixed?).
- Marketplace scope: buy-only vs buy+sell in v1; soft-coin pricing; showroom presence detail
  (which cars shown, bot density).
