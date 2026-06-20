# Perps Raider — Product Roadmap & MVP — master plan

**Date:** 2026-06-20
**Status:** reviewed (6 forks locked) — revised after a 4-lens adversarial review
**Last revised:** 2026-06-20 — folded in the resolved **distribution split**, **wallet architecture (one `AppSigner` port)**, **Seeker smoothness guardrails**, and **staged on-chain anchor proofs**; then reconciled phase placement, marketplace-sell scope, compliance-build tracking, and research-faithfulness per review.
**Branch:** redline-3d
**Scope:** the whole product (live-service game + synthetic-perp fintech), not a single feature.

This is a **master roadmap**, not an implementation spec. It decomposes the vision into
pillars, fixes the build order, and defines the MVP / first release. Each pillar then gets
its **own** `spec → plan → implement` cycle, linked from the table at the bottom.

---

## What we are building

A live-service arcade game for the Solana Seeker where the core loop is a **real-money
synthetic perp** on a live price feed, skinned as arcade driving. *(Real value is in scope for
the v1 release line but switched on **last** — Alpha runs entirely on test balances; see Strategy.)*
On top of that loop:
collectible coins → crates → cars-with-abilities (Pokémon-style), unlock progression, a
real-time hangout lobby, and daily engagement. The house is the counterparty (a synthetic
vault), hedged in aggregate — it is **not** a per-trade on-chain DEX.

## Locked decisions (the forks that shaped this plan)

1. **Real money in v1**, onboarded via **Privy** as the baseline embedded-wallet lane (auth +
   embedded wallet + on-ramp/KYC via Privy partners). No separate KYC *vendor* build — but
   **"no KYC vendor" ≠ "no compliance build":** runtime **geofencing + an age gate** are our own
   code to write (a Beta prerequisite — see Pillar 6 / phase 5). Privy is the *floor*, not the
   whole story — **Seed Vault is a native Seeker enhancement** (see *Distribution & wallet
   architecture*).
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
5. **Distribution split — real money never ships inside a mainstream-store build.** A real-money
   leveraged price-bet reads as *binary options*: Apple bans those outright ("Consider a web app
   instead", §3.2.2 viii) and Google leaves perps unaddressed-but-adjacent-to-banned, while its
   blockchain policy bans "wager/stake to win real-world monetary value." So **real money lives
   on the web PWA + APK sideload + the Solana dApp Store**, and **Apple/Google get a scrubbed
   soft-coin "lite" build with no wallet and no cash-out.** This costs us nothing: soft-coin-first
   *is* the lite build. (See *Distribution & wallet architecture*.)
6. **Wallet = one `AppSigner` port; the channel picks the backend.** "Privy vs Seed Vault" is a
   false choice. Privy embedded is the baseline "play-balance" wallet everywhere money is allowed;
   **Seed Vault via native MWA** is a Seeker enhancement (deposit/withdraw, never a second
   balance); the mainstream lite build has **no wallet at all**. One interface, three backends.

## Pillars (decomposition) and current state

| | Pillar | State today |
|---|---|---|
| A | **Core race loop** — real perp on a live feed, skinned as driving | ✅ mostly built (client + server settlement) |
| B | **Lobby / economy hub** — Garage+marketplace, Upgrades, Crate Shop, Track gate | 🟡 3-market version built; being repurposed |
| C | **Progression** — characters, skill trees, per-car abilities, crates, coin | 🟡 ability scaffold only |
| D | **Economy** — coin sources/sinks, crate odds, anti-inflation | ❌ |
| E | **Backend** — accounts, auth, server-authoritative balances + inventory, anti-cheat | 🟡 ledger + settlement built; auth still dev-stub |
| F | **Vault + real money** — off-chain ledger, USDC treasury, solvency, hedging | ❌ (SimSettlement stub) |
| G | **Marketplace** — buy/sell/trade cars & crates | 🟡 **soft-coin market in v1**; real-money item cash-out post-v1 |
| H | **Live-ops** — daily bonus, seasons, retention | ❌ |
| I | **Verifiable settlement** — signed-price provenance + public recompute + on-chain anchor | 🟡 design spec written; staged, devnet-first |
| J | **Wallet + distribution** — `AppSigner` port, multi-store split, lite build | 🟡 architecture locked (forks 5–6); not built |

### Dependency reality (why the order is what it is)

- The instant a coin has value (C/D), the client **cannot** be trusted with balances →
  **E (server authority) is the foundation**, not a nice-to-have.
- With real money, the **RoundEngine must run server-side** (authoritative settlement). The
  client becomes a renderer. The engine is already TypeScript, so it ports cleanly. *(Done — 1.2.)*
- **F (real money)** is gated by a **jurisdiction legal read** + the vault solvency design.
  This is an owner dependency that runs in **parallel from day one**.
- **I (anchor proofs)** depends only on settlement (1.2) and is **server-side** — it never enters
  the client or the render loop, so it is off the smoothness critical path and can ship on devnet
  while everything else is still soft-coin.
- **J (wallet)** is needed only when real value moves (F). Until then, auth runs on the dev stub.
  The `AppSigner` port should be defined early (Pillar 1.3) so auth, deposits, and signing have a
  stable seam, but the chain backends light up at F.

## Strategy: build everything on test balances, flip real money LAST

Even though real money is in v1, the entire game is built and proven on **soft/test
balances**, then real value is switched on once the vault + legal read are ready. The money
switch is the last thing flipped, not the first. **Two corollaries from the 2026-06-20 decisions:**

- The **mainstream-store build is exactly today's soft-coin build** — no wallet, no cash-out — so
  "build soft-coin first" and "have an Apple/Google-safe build" are the same effort, not two.
- **Anchoring runs live on devnet** (real transactions, throwaway relayer keypair) during the
  whole soft-coin phase, so the entire proof path is exercised before mainnet ever matters.

### Phased build order (within v1)

1. **Server foundation (E).** Backend skeleton, **auth + `AppSigner` port** (Privy baseline,
   swap the `x-dev-user` stub — Pillar 1.3), Postgres, server-authoritative coin balance + car
   inventory, **port RoundEngine to the server** *(done — Pillar 1.2)*, the **commit-reveal RNG
   *primitive*** (the full provably-fair crate feature is Pillar 2), and the **autonomous liq/time
   settler worker** (Pillar 1.4 — single-instance; settles abandoned/timed-out rounds; *required
   before real money*, so built in the soft-coin era). Outcome: the game becomes cheat-proof,
   no real money yet.
2. **Economy content (C/D/H).** Crates → car drops with abilities (extend the existing
   scaffold), daily bonus, coin sink/source tuning. On soft balances.
3. **Lobby economy hub (B) + async presence.** Repurpose the lobby into the economy town
   (Garage+marketplace, Upgrades, Crate Shop, Track gate) wired to the ledger/inventory;
   showroom presence via async REST (parked / for-sale cars + bots), **no Colyseus in v1**.
   Real-time avatars are a post-v1 add.
4. **Verifiable settlement on devnet (I).** Anchor proofs **Stage A** (signed-price capture +
   public recompute + `GET /v1/round/:id/proof`) and **Stage B on devnet** (Merkle root → Solana
   via SPL Memo, throwaway relayer key). **Server-side, soft-coin era, off the smoothness path** —
   exercises the whole proof path before mainnet ever matters. Depends only on settlement (1.2),
   so it runs alongside phases 2–3; it is **not** gated on real money.
5. **Real money (F).** USDC treasury + deposit/withdraw via the `AppSigner` backends, off-chain
   settlement ledger, **geofencing + age-gate enforcement** (our code — a Beta prerequisite,
   *distinct from* the legal read it implements), **solvency + reconciliation + manual FlashTrade
   hedging** (automation post-Beta), **flip anchoring to mainnet + relayer key custody**, then flip
   settlement from test → real value. **Gated by the legal read.**
6. **Hardening.** Anti-cheat, multiplayer load test, vault stress test, monitoring/alerting,
   **`/proof` endpoint rate-limiting**, and the **final on-device Seeker perf sign-off** (an early
   feasibility *spike* already ran in Alpha — see *Seeker smoothness guardrails*).

### Build progress (live)

- **Pillar 1.1 — Ledger foundation (E): ✅ BUILT.** `server/` skeleton (Fastify 5 + Drizzle + Postgres/PGlite), append-only integer-coin ledger (`balance = sum(delta)`, advisory-lock debit + overdraft guard + `(reason,ref)` idempotency), unlock-only car inventory, dev `x-dev-user` auth seam, REST routes (`/v1/me|balance|inventory` + dev seed), Railway deploy path (migrate-on-release). Overdraft race verified on real Postgres.
- **Pillar 1.2 — Server-side authoritative settlement (A→server): ✅ BUILT** (test money). The race now settles on the server. Delivered:
  - **Shared `@perps/engine` workspace** — the pure P&L/leverage math moved out of the client into one package both client and server import (drift impossible); client `src/core/*` are thin re-export shims.
  - **Pure `settleRound`** — deterministic, integer-coin, **segment-replay** (the Clown Car flip + leverage changes fold through `rebank`); reuses `equityOf`/`payoutOf` verbatim (linear-from-entry, vol-independent).
  - **`rounds` + `round_actions` tables** — authoritative, auditable, crash-recoverable round record with a **per-round config snapshot** (defeats the mutable-`CONFIG` bleed).
  - **`PriceFeed` port** — deterministic stub for tests + a real Hermes REST poll, both with **HALT-on-stale** (never settle on a frozen feed); feed ids verified against the client.
  - **`/v1/round/open|action|close|:id`** behind `requireUser`; **single-writer settle** (advisory lock + `open→settled` status guard + `WHERE status='open'` + idempotent `round_payout` ref) — **concurrent double-close → single credit verified on real Postgres**.
  - **Deferred (explicit):** autonomous liq/time settler worker (1.2 settles only on explicit `close`; an abandoned round leaves an escrowed-stake open round — fine for test coins; **now tracked as Pillar 1.4, required before real money**); **pickups/`addBonus`** (engine-supported, no API yet); per-user upgrade-tree → effective `cfg`; the vol-spike dynamic leverage cap (Plan F vault lever); Lazer WebSocket; **auth still `x-dev-user`** → Pillar 1.3.
- **Strategic decisions locked 2026-06-20 (research-backed, not yet built):**
  - **Distribution split + wallet architecture** (forks 5–6) — real money only on web PWA / APK / dApp Store; mainstream stores get a no-wallet soft-coin lite build; one `AppSigner` port, channel picks backend. → *Distribution & wallet architecture*, Pillar 1.3 / J.
  - **Anchor proofs** — design spec written, staged, devnet-first, fully server-side. → *Verifiable settlement*, Pillar I; spec [`2026-06-20-verifiable-settlement-anchor-proofs-design.md`](2026-06-20-verifiable-settlement-anchor-proofs-design.md).
  - **Seeker smoothness** — the #1 client risk is WebGL on a weak Mali-G615 GPU inside the throttled Android WebView (NOT the chain). → *Seeker smoothness guardrails*.

## Architecture

```
┌─────────────────────────────┐         ┌──────────────────────────────────────────┐
│ CLIENT (exists)             │         │ BACKEND (Node/TypeScript)                  │
│ Three.js / Vite / Capacitor │  REST   │  • Auth (verify Privy tokens / dev stub)   │
│  • render race + lobby      │ ──────► │  • Economy/inventory service (Postgres)    │
│  • input                    │         │  • Settlement service (authoritative       │
│  • AppSigner port:          │  WS     │    RoundEngine off the Pyth feed) ✅        │
│    privy-embedded /         │ ──────► │  • Anchor worker (signed-price + Merkle     │
│    mwa-seedvault /          │         │    root → Solana; server-side only)        │
│    none (lite build)        │         │  • Realtime room server (Colyseus + Redis) │
│  • renderer only for $$     │         │  • Vault: off-chain ledger + USDC treasury │
│    settlement               │         │    (Solana), hedged on FlashTrade          │
└─────────────────────────────┘         └──────────────────────────────────────────┘
```

- **Build & deploy targets (one Vite codebase, two client shells).** The client builds once with
  `vite build` and ships as **(a) a web PWA hosted on Vercel** — a *real browser* on desktop +
  mobile web — and **(b) a Seeker APK via Capacitor** (Android System WebView wrapping the same
  build). The server deploys to **Railway**. The **Vercel web build is the broadest real-money
  surface** and — per Apple's "consider a web app instead" — the **iOS real-money path**; the
  **Seeker APK** is the crypto-native showcase with native Seed Vault. Same code, two shells, two
  deploy pipelines (Vercel + Capacitor), one Railway backend.
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
  a bad tick = mass false liquidations. The settlement loop has a tick-recency watchdog + safe-mode
  HALT and tick validation (monotonic ts, sane bounds) *before* price touches equity math (built in 1.2).
- **All chain interaction is server-side.** The relayer keypair, signed-price capture, Merkle
  root, and the Solana anchor transaction live on the backend. The client never imports a Solana
  lib, holds a key, builds a transaction, or hits an RPC for gameplay or proofs — see the
  **"no Solana lib in the client"** rule under *Verifiable settlement*. The **only** client chain
  touch is the deferred money-phase wallet connect, isolated behind the `AppSigner` port.
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

### Seeker smoothness guardrails (the real #1 client risk)

Research (2026-06-20) is blunt: **the biggest threat to a "very smooth" Seeker experience is not
the chain — it's WebGL on a weak GPU inside a throttled WebView.** The chain work is server-side and
invisible to the phone; the rendering work is where tuning buys smoothness.

**Scope — this is a *Seeker-APK* concern, not a web concern.** The **Vercel web build runs in a real
browser** (Chrome / Safari / Firefox), which gets **full GPU budget and no WebView tax** — so the web
version is the *smoother* surface, and the guardrails below target the **Capacitor / Android-WebView**
path specifically. (The Mali-G615 *hardware* ceiling still applies to anyone running the web build in
a mobile browser on a low-end phone, but without the WebView penalty on top.)

- **The hardware:** Seeker is mid-range by design — MediaTek Dimensity 7300, **Mali-G615 MC2
  (2-core)** GPU, scores low in GPU tasks. The 120 Hz panel is a **trap**: target a **stable 60
  with a clean 30 fps thermal fallback**, never 120.
- **The WebView tax:** Android System WebView is *reported* — **anecdotally, not yet benchmarked
  on a Mali-G615** — to get less GPU budget than Chrome, so this **must be measured on a real
  device**, not assumed. Specific killer: when an accessibility service is on, the WebView mirrors
  the DOM into an accessibility tree and **blocks the JS thread** — which punishes our every-frame
  DOM HUD (tach / coins / leverage).
- **Guardrails (enforce on the Seeker tier — *illustrative* knobs; exact numbers get specced in
  the Seeker-perf hardening pillar):**
  - **Cap `devicePixelRatio` to ~1.5–2**, never render at native 2670×1200.
  - **Shrink the live DOM HUD** — move it in-canvas, or use minimal `transform`/`opacity`-only
    absolutely-positioned elements; avoid deep DOM updates every frame.
  - **Trim post-processing** ([`render/post.ts`](../../../src/render/post.ts)) on the Seeker tier;
    keep draw calls < ~100; Draco + KTX2 compressed assets; dispose GPU resources.
  - Add a **Seeker / Mali-G615 quality tier** to the existing [`platform/perf.ts`](../../../src/platform/perf.ts)
    budgeter; consider `OffscreenCanvas` + Worker so REST/economy JS can't starve rendering.
- **Measure on a real mid-range device**, not Chrome desktop and not the preview harness (the
  "~1.5 fps in preview" figure is a harness artifact, not device perf). An early feasibility
  **spike** runs in **Alpha**; the final perf **sign-off** is the **phase-6 hardening gate** — two
  distinct passes, not the same one scheduled twice. A **throwaway on-device Seeker test build**
  should settle the two unknowns no doc resolves (see *Verify-on-device unknowns* below) **before**
  the money-phase wallet architecture is committed (it picks Custom-Tab-plugin vs native-shell).

## Distribution & wallet architecture

Resolved 2026-06-20 (forks 5–6), grounded in app-store policy + wallet research. This section
*is* the answer to "is Privy the right way, how does it meet Seed Vault, and what about Google/Apple."

### The store-policy reality (why real money goes off the mainstream stores)

- **Apple** §3.2.2(viii): *"Apps that facilitate binary options trading are not permitted on the
  App Store. Consider a web app instead."* CFDs/derivatives "must be properly licensed in all
  jurisdictions"; crypto futures "must come from… regulated financial institutions" (§3.1.5 iv).
  A fixed-stake leveraged price-bet most resembles a **banned binary option** → high native-iOS
  rejection risk. Apple itself points such apps to the web.
- **Google Play:** binary options is the **only** name-banned speculative instrument (perps/CFDs
  are *unaddressed* — do not assume permitted); the **blockchain/NFT policy bans "wager or stake…
  to win prizes of real-world monetary value"** and bans glamorizing earnings — which hits the core
  mechanic *and* its marketing. Tokenized in-app content can trigger Google Play Billing (whether a
  pure on-chain wallet→contract transfer is exempt is **UNVERIFIED — needs a written ruling**).
- **Compliance burden is the developer's:** all KYC/AML, runtime geofencing, and the 18+/21+ gate
  are built by us; the stores provide country dropdowns + (new) age *signals* only, never a license.
- **Solana dApp Store is permissive:** "gambling/casino/real-money" appear nowhere in the Publisher
  Policy; 0% fee, no forced IAP, value moves wallet→contract (store never custodies). *Clash of
  Perps* (a perps game) is already listed — we would not be first in the category.

### Distribution matrix

| Channel | Real money? | Wallet backend | Build |
|---|---|---|---|
| **Web PWA** (any browser, **hosted on Vercel**) | ✅ yes | Privy embedded, or connect extension | full |
| **Seeker APK** (Solana dApp Store) | ✅ yes | **native MWA → Seed Vault** (+ Privy for newcomers; **one balance** — Seed Vault funds the embedded play-balance, never two parallel balances) | full |
| **Plain Android** (APK sideload) | ✅ yes | Privy embedded | full |
| **iOS** (no real sideload) | ✅ **via the web PWA only** | Privy embedded (in the PWA) | full (PWA) |
| **Google Play / Apple App Store** | ❌ soft-coin only | **no wallet at all** | lite (scrubbed) |

The **lite build** carries no cash-out, no token/NFT/wallet-gated unlocks, uses Apple IAP for any
coin purchase, and is descriptively cleansed of "trading / crypto / cash-equivalent" framing. The
redemption seam and crypto branding — not the gameplay — are what trigger store rejection. Precedents:
*Off The Grid* (blockchain ON via Epic, OFF on console), *Axie Lite*, Telegram mini-apps.

### The wallet port

One narrow signer interface; all game/settlement logic is backend-agnostic:

```ts
interface AppSigner {
  publicKey: Address;                       // web3.js v2 / @solana/kit
  signTransaction(tx): Promise<Tx>;
  signMessage(m: Uint8Array): Promise<Uint8Array>;
  readonly backend: 'privy-embedded' | 'privy-external' | 'mwa-seedvault';
}
```

- **Privy is the baseline**, officially supported in Capacitor (web `react-auth` SDK in the
  WebView; OAuth via the native system browser + App Links). Custody = TEE + 2-of-2 Shamir
  sharding. Solana-native, uses `@solana/kit` (**web3.js v2** → no Buffer-polyfill bloat). Built-in
  fiat on-ramp + KYC-via-partner.
- **Privy cannot drive Seed Vault** — it has no MWA support. Seed Vault is reached as a **separate
  backend** via **native MWA** (a Capacitor plugin wrapping the Kotlin/`transact()` client, or a
  Chrome Custom Tab) — **not** the in-WebView web MWA plugin, which is Chrome-only and fragile in a
  WebView (**Low-to-Medium confidence**: the policy-level conclusion is Medium, but the only public
  Capacitor↔MWA bridge is a dead 2022 hackathon POC, so the supporting evidence is Low — a
  verify-on-device item).
- **Two onboarding lanes:** *"no wallet yet → Privy embedded"* vs *"I have a wallet → connect
  (MWA/Seed Vault/extension)."* The rule that prevents confusion: **embedded = the play/ledger
  balance; Seed Vault = deposit source + withdraw destination — never two parallel balances**
  (linking unifies identity, not funds).
- **`@solana/web3.js` v2 / `@solana/kit`** throughout to avoid Buffer polyfills and shrink the
  bundle; `npm ls @solana/web3.js` to confirm no transitive v1.

### Verify-on-device unknowns (fold into the throwaway Seeker build; neither blocks the decision)

1. Privy inside iOS `capacitor://localhost` — secure-context + storage persistence.
2. Whether native MWA reaches Seed Vault from a Capacitor app, or the Seeker build needs a native
   MWA bridge plugin (no official Capacitor MWA story exists). This answer picks the Seeker shell shape.

## Client surfaces — web interface & platform UX

One Vite build renders on **three very different profiles**; the UI, input, *and* render quality must
**adapt per surface**, not assume the Seeker. These are roadmap-level considerations — the concrete
control scheme, breakpoints, quality tiers, and PWA manifest get specced in the client/web pillar (1.5).

| Surface | Quality tier | Input | Orientation | Wallet |
|---|---|---|---|---|
| **Desktop web** (Vercel) | **HIGH** — strong GPU: more pixels, full post-FX, longer draw distance | keyboard + mouse (+ optional gamepad) | landscape | Privy embedded |
| **Mobile web** (Vercel) | **MID** | touch + tilt | portrait | Privy embedded |
| **Seeker APK** (Capacitor) | **LOW** — Mali-G615 + WebView tax | touch + tilt + haptics | portrait | native Seed Vault / MWA (+ Privy) |

- **Input model differs by surface.** Seeker / mobile-web = **touch** (steer, throttle/brake, flip,
  leverage, nitro) + tilt + **haptics**, portrait. Desktop = **keyboard + mouse** (and optional
  **gamepad**), landscape, **free window-resize**, **fullscreen**. The current client is touch-only;
  desktop needs a full **keyboard/mouse control scheme**, not a touch-overlay fallback.
- **Web is the primary acquisition funnel.** A shareable **Vercel URL has zero install friction** —
  most players will land on the web build; the Seeker APK / dApp Store is hardware-gated, smaller
  reach. So **web-first UX polish** (instant load, no-wallet trial, responsive) is where growth comes
  from; Seeker is the premium crypto-native surface, not the top of the funnel.
- **Installable PWA.** Web manifest + icons + offline shell + "Add to Home Screen"; fullscreen /
  orientation handling on mobile-web. (`index.html` already carries the brand title + apple-title.)
- **Wallet UX is lighter on web.** The web build's wallet is **Privy embedded** (email login, in-browser
  modal) — the lowest-friction onboarding, and the **iOS real-money path**. No native Seed Vault / MWA
  complexity on web; that's the Seeker-only path.
- **Desktop is a first-class, *optimized* profile — not "just runs in a browser."** It's the **HIGH**
  quality tier (the inverse of the Seeker constraint): a strong GPU takes a **higher pixel-ratio cap,
  full post-processing, longer draw distance, more particles**, at a **landscape-first composition**
  (the HUD/canvas *reflows*, not a scaled-up portrait). `platform/perf.ts` owns the tier ladder
  **Desktop-HIGH ↔ mobile-web-MID ↔ Seeker-LOW**. The DOM-HUD JS-thread-stall concern is
  **Seeker-WebView-only** — desktop has full GPU + main-thread headroom.
- **Web-native share / verify.** URL-based round share + the anchor-proof **"verify" link** (a plain
  `https://` page — server string + link, no client Solana lib) are natural on web and land here first.

## Verifiable settlement — staged anchor proofs (Pillar I)

Detailed design: [`2026-06-20-verifiable-settlement-anchor-proofs-design.md`](2026-06-20-verifiable-settlement-anchor-proofs-design.md).
Purpose: give crypto-literate players a way to independently check that each round was settled on a
real, signed oracle price — the wedge over competitors (e.g. Banana Zone) who publish no fairness
model. **Entirely server-side; off the smoothness critical path.**

**Honest scope (don't oversell the wedge):** the proofs establish *price provenance* (a real
signed oracle price), *no after-the-fact edits*, and *sequence completeness*. They do **not** prove
vault solvency, **not** real-time engine-execution integrity (a malicious operator dropping/reordering
rounds is caught only by the monotonic counter, not prevented), and they are **not** regulatory cover.
(Mirrors the sub-spec's non-goals — the owner-facing claim must carry the same honesty as the spec.)

- **Stage A — provable without a chain.** Capture the **guardian-signed Pyth price** at each
  server-stamped mark; store a per-round price-proof; expose a public `GET /v1/round/:id/proof`
  and a `verifyRoundProof` that re-runs the *same* `@perps/engine` math to recompute the outcome.
  Anyone can verify signatures + recompute the payout. No on-chain dependency yet.
- **Stage B — on-chain anchor.** A single-instance anchor worker batches round leaves into a
  **Merkle root** and posts it to **Solana via SPL Memo** (`devnet` first, env relayer keypair,
  then mainnet at the money switch). Per-round cost ≈ $0. The proof endpoint then also returns the
  anchoring tx + Merkle path.

**Amendments to fold when this pillar's spec is finalized (before its plan):**

1. **"No Solana lib in the client" rule (cross-cutting).** The verify UX is a **server-returned
   string** ("anchored ✓", root hash, tx signature) plus a **plain `https://` link** to a server /
   explorer page. The client must never `import @solana/web3.js` for verification (would drag the
   Buffer/polyfill bundle bloat onto the phone for a feature ~1% of users tap) and never re-compute
   Merkle proofs on-device. Keeps the proof feature off the Seeker smoothness path.
2. **Round-sequence completeness.** Anchor a **monotonic round counter** so a censored / dropped
   round is publicly detectable, not just each round individually provable — closes the "did they
   hide a losing round?" gap cheaply.
3. **Proof-of-reserves is a separate, later track (non-goal here).** Anchoring proves *fairness of
   each round*, **not solvency of the vault**. A PoR companion (treasury attestation) is its own
   future pillar under F; the anchor spec states this as an explicit non-goal so the claim isn't
   over-sold.
4. **Devnet-beta phase.** Anchoring runs live on **devnet** (real tx, throwaway keypair) while the
   game is still soft-coin, exercising the whole proof path end-to-end before mainnet.

## Lobby — the economy hub

The lobby is the **town**: a drivable space whose buildings *are* the economy. It replaces the
original 3 market-select buildings (SOL/BTC/ETH).

**Navigation flow:** the game **launches straight into the Track** — the race is home, so players
land in the core loop with no menu friction. You **drive to the Lobby** (map/garage button) to
manage your car & economy, then take the **Track gate** back out to a race (picking the market on
the way). The lobby is a *side-trip for the economy*, not the front door. (This matches today's
client: it boots into the race; the map button opens the lobby.)

- 🏠 **Garage** — your car collection + the **marketplace** (browse / buy / **sell** cars in soft
  coins — sell **is** in v1 per fork 2). Doubles as showroom — other players' cars + "for sale"
  tags populate the world.
- 🔧 **Upgrades** — buy upgrades from the **existing upgrade tree** ([`ui/upgrades.ts`](../../../src/ui/upgrades.ts),
  which already tunes LIQ/MAXSEC/RMAX). Spent in soft coins.
- 📦 **Crate Shop** — spend coins on **provably-fair** crates → cars with abilities.
- 🏁 **Track gate** — drive in → pick **SOL / BTC / ETH** → launch the race. Market selection
  lives here now (previously the 3 buildings).

Everything is **server-authoritative** (marketplace prices, what you own, what a crate drops)
and **soft-coin** denominated in v1. **Presence is async** (parked/for-sale cars, bots) —
real-time avatars are post-v1. This supersedes the 3-market lobby in
[`2026-06-19-garage-lobby-design.md`](2026-06-19-garage-lobby-design.md): the drive-into-a-building
interaction model carries over; the buildings' purpose changes.

## MVP / First release — definition

The first release is a **real-money, multiplayer, unlock-progression game** — built test-first,
real value switched on at the end, and shipped through the **full channels** (web PWA + Seeker dApp
Store + APK); a **scrubbed soft-coin lite build** covers Apple/Google. In scope:

- **Two client shells, three profiles, from one Vite build:** a **responsive web PWA on Vercel** —
  **desktop-optimized** (landscape, keyboard/mouse + gamepad, HIGH quality tier) *and* mobile-web
  (touch) — the primary funnel; plus the **Seeker APK** (touch + native Seed Vault, LOW tier).
- Core race on the real feed, **server-authoritative settlement** (the web client drives `/v1/round/*`,
  not a local sim) with **public per-round proofs** (anchor Stage A; Stage B anchor on devnet→mainnet).
- **`AppSigner` wallet port:** Privy sign-in + embedded wallet (web/plain); **Seed Vault via native
  MWA** on Seeker; **USDC deposit/withdraw**; off-chain settlement ledger.
- Single soft currency (**coin**) earned by playing; server-authoritative balance.
- **Crates** bought with coins, **provably-fair**, dropping **cars with abilities**
  (**target** 6–8 cars, each a real ability — exact roster + count specced in Pillar 3; extend the
  existing scaffold). **Unlock-only** (bound).
- **One daily bonus** (the single retention hook for v1).
- **Lobby economy hub** — Garage+marketplace, Upgrades, Crate Shop, Track gate; soft-coin
  buy/sell/trade; async showroom presence (no real-time netcode in v1).

**Cut from v1 (own specs later):** characters + skill-tree abilities (cars carry the
abilities for v1), **real-time avatar netcode (Colyseus)**, **real-money item cash-out**,
**proof-of-reserves**, seasons, chat/voice/emotes, car-to-car collision.

### Release sequence

- **Alpha** — phases 1–4 complete, running on **test balances** (real game, no real money), with
  **anchor proofs live on devnet**. Internal + closed testers. Validates fun, the economy/marketplace
  loop, crate balance, and the full proof path. Includes an early **on-device Seeker perf spike**
  (fps feasibility on a real Mali-G615) — the final perf sign-off is the phase-6 gate.
- **Beta** — phase 5: real USDC turned on for a limited cohort (web + Seeker + APK), small caps,
  vault watched closely, **anchoring flipped to mainnet**, **geofencing + age gate live**. Legal
  read complete before this gate.
- **v1.0** — phase 6 hardening done, caps raised, public Seeker release; **lite build submitted to
  Apple/Google**.
- **Post-v1** — real-money item cash-out, proof-of-reserves, real-time avatars, characters + skill
  trees, seasons, social.

## Risks & owner dependencies

- **Legal / jurisdiction read (owner-owned, parallel from day 1).** A real-money game where
  the house is counterparty is regulated (gambling/CFD-style rules vary by country). Privy is
  **not** a license. This gates the Beta real-money switch — nothing else blocks on it, so it
  must start immediately.
- **Mainstream-store classification (real, partly unresolved).** A synthetic perp may be read as a
  banned binary option (Apple) or an unaddressed derivative (Google). Mitigated by **never shipping
  real money in a store build** (fork 5); two items still want a **written platform ruling** before
  relying on a store: (a) whether an on-chain wallet→contract transfer escapes Google Play Billing,
  (b) whether the synthetic perp is classed as a binary option vs a licensable derivative.
- **Seeker client performance (the #1 smoothness risk).** WebGL on a Mali-G615 inside a throttled
  Android WebView — see *Seeker smoothness guardrails*. Mitigated by a Seeker quality tier, an early
  **Alpha feasibility spike**, and the **final on-device sign-off in phase-6 hardening**; the
  WebView-vs-Chrome GPU gap is anecdotal, so **must be measured on device**, not in the preview harness.
- **Native MWA from a Capacitor WebView (thin evidence).** No official Capacitor↔MWA path; the
  in-WebView plugin is Chrome-only/fragile. Mitigated by keeping the WebView render-only and putting
  any chain touch behind a native plugin / Custom Tab — a verify-on-device item.
- **Vault solvency + reconciliation.** Enforced in code (linear P&L + leverage cap + exposure
  limits + bankroll floor). **Plan F adds system/treasury accounts so the books sum to zero, plus a
  continuous reconciliation drift-check that auto-halts withdrawals on mismatch** — this lives in
  plan F, not phase-5 hardening. Stress-tested before real value goes live.
- **Server-authoritative settlement refactor.** *Done (1.2)* — de-risked by porting the existing TS
  engine rather than rewriting.
- **Provably-fair crates.** Commit-reveal seeds, verifiable client-side — required before
  coins (let alone money) buy crates.
- **Privy scope.** Solves auth + wallet + on-ramp. Does **not** solve vault solvency,
  settlement correctness, licensing, or Seed Vault (that's native MWA).
- **Empty-lobby cold start.** At launch the world is near-empty; defeat the "dead game" look
  with **async showroom presence** (real players' parked / for-sale cars + a few bots) and by
  concentrating who's online — *not* with real-time netcode. Real-time avatars (+ Redis room
  sharding) come post-v1, once population justifies them.

## Per-pillar spec plan (each gets its own spec → plan → implement)

> **Reading the IDs:** pillars are referenced two ways. **Letters A–J** name *capabilities* (the
> decomposition table at the top). **Numbers** (1.1, 1.2, 1.3, 1.4, 2–7, plus `I`) name the
> *spec→plan→build units* in this table, each tagged with the capability it advances — e.g. `(E)`,
> `(A→server)`, `(F)`. So "Pillar 1.3" is the build unit; its `(E/J)` tag says it advances
> capabilities E and J. The lone `I` is both the capability letter and its build-unit key (1-to-1).

| Order | Pillar spec | Depends on | Notes |
|---|---|---|---|
| 1.1 | Backend foundation + ledger + inventory (E) | — | ✅ BUILT — ledger + inventory + dev auth + REST |
| 1.2 | Server-side RoundEngine / settlement service (A→server) | 1.1 | ✅ BUILT — `@perps/engine` + segment-replay settle + `/v1/round/*`; single-writer verified on real PG |
| 1.3 | **Auth + `AppSigner` wallet port (E/J)** | 1.1 | **define the port + stub backends now** (privy-embedded baseline; mwa-seedvault stub) — full Privy auth + chain backends **activate at F**, *not* before crates |
| 1.4 | **Autonomous liq/time settler worker (A)** | 1.2 | single-instance, monotonic-clock; settles abandoned/timed-out rounds. **REQUIRED before real money (F)** — built in the soft-coin era. May share the single dyno with the anchor worker |
| 1.5 | **Client → server cutover + web surface (A/J)** | 1.2 | web client drives `/v1/round/*` (SimSettlement retired as the authority; local engine = render prediction only); **landscape-first desktop layout + keyboard/mouse (+ gamepad)** and a **Desktop-HIGH quality tier** (more pixels / post-FX / draw distance); installable PWA on Vercel. Makes the built backend real on the web version |
| 2 | Provably-fair crates + economy (C/D) | 1.1 | soft balances; consumes the **commit-reveal RNG primitive** seeded in 1.1 |
| 3 | Car abilities + unlock progression (C) | crates | extend scaffold; sets the v1 car count |
| 4 | Lobby economy hub + soft-coin marketplace (B/G) | 1.1, crates | the town: Garage/Upgrades/Crates/Track; **buy/sell/trade in soft coins** (sell in v1, fork 2) |
| 5 | Daily bonus + live-ops (H) | 1.1 | cheap once E exists |
| I | **Verifiable settlement — anchor proofs (I)** | 1.2 | spec written; Stage A (recompute) → Stage B (**devnet Merkle anchor — lands in Alpha**); **server-side, off the smoothness path**; +4 amendments to fold |
| 6 | Vault: USDC treasury + ledger + hedging (F) | 1.2, **1.3, 1.4**, **legal read** | flips real money on; **+ geofencing + age-gate enforcement** (code, distinct from the legal read), **anchoring → mainnet + relayer key custody** |
| 7 | Hardening: anti-cheat, load + vault stress, **final Seeker perf sign-off**, **`/proof` rate-limiting** (phase 6) | all | pre-launch gate |
| — | Lite build for Apple/Google (J) | 6 | scrubbed soft-coin, no wallet; own submission spec |
| — | Proof-of-reserves (treasury attestation) | 6 | post-v1; separate from anchor proofs |
| — | Real-money item cash-out + real-time avatars | post-v1 | deferred |
| — | Characters + skill trees | post-v1 | deferred |

## Open questions (resolve at each pillar's own spec)

- Coin economy numbers: earn rates, crate prices, drop odds, sink/source balance.
- Exact car roster + ability designs (the Pokémon-style kit).
- Treasury custody specifics + withdrawal limits/cooldowns.
- Daily-bonus mechanic (streak? wheel? fixed?).
- Marketplace mechanics (**sell IS in v1** per fork 2): soft-coin pricing model, listing/escrow
  flow, anti-wash-trade sinks, showroom presence detail (which cars shown, bot density).
- **Seeker shell shape** (1.3 / J): native MWA bridge plugin vs Chrome Custom Tab vs native Kotlin
  shell hosting the WebView — decided by the on-device MWA test.
- **Anchor verify UX surface:** in-app proof panel (server strings + link) vs a dedicated
  `/verify/:roundId` web page — resolve in the anchor-proofs plan.
