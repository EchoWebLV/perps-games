# Cross-platform Privy + Server-Account Slice — Design

**Date:** 2026-07-07
**Branch:** `intro-clarity` (Cross-platform / Seeker pillar)
**Status:** Design — decisions captured this session; awaiting spec review before planning.
**Target:** MagicBlock mobile hackathon, July 10–12 2026.

## Goal

The **same player** plays on **computer, phone, and Seeker** with **one identity** and **one set of stuff** (coins, scrap, cars) that follows them across devices.

Decisions locked this session:
- **Privy is the only wallet, everywhere** (desktop, iPhone PWA, Seeker APK). Native Seed Vault/MWA is deferred: its keys are hardware-bound to the Seeker, so it would split one player into two accounts across devices.
- Cross-device continuity is a **server-account** problem, **not** on-chain. Coins/scrap/cars bind to the **Privy identity** on the existing `@perps/server` backend.
- **NFTs / trading are a separate later pillar.** Only *tradability* needs chain; continuity does not.
- **Order = thin slice both:** ship the Privy-everywhere mobile build AND a minimal server-account migration together, so mobile launches with real continuity.

## Non-goals (explicitly deferred)

- On-chain NFT ownership of cars/crates; any marketplace or trading. (Pillar: Tradable NFTs.)
- Native Seed Vault / MWA signing. (Optional later add-on on top of the Privy identity.)
- Mainnet real-money cutover. (Pillar: Mainnet real money.)
- Live multiplayer presence. (Pillar: Live lobby — will reuse this same server.)
- Reworking round settlement (rounds settle on-chain via the Ephemeral Rollup today).

## Current state (verified 2026-07-07)

- **Wallet:** `chain/wallet-select.ts` `selectChainWalletPort()` defaults to Privy; the app already uses Privy on every platform it runs on. The native MWA path (`core/solana-wallet.ts` / `core/mobile-wallet-port.ts`) exists but is unwired — and now deferred.
- **Client game-state lives in `localStorage`, per-device:**
  - `redline.garage.v1` → `{ coins, scrap, levels{tank,turbo,suspension}, finishes{carId→finishId} }` (`ui/upgrades.ts`).
  - `core/inventory.ts` → **counted** car collection (dupes stack, spares meltable, last copy kept) + owned world-skins, under its own key.
- **Server `@perps/server` (Fastify + Drizzle + Postgres) already has:**
  - `users` keyed by unique `walletPublicKey`; **wallet-signature auth** (ed25519 nonce challenge → HMAC session token) in `src/auth/{wallet-binding,session}.ts`.
  - append-only **`ledgerEntries`** (assets `coin` = soft play money, `cash` = USDC-backed/withdrawable; balance = Σ delta; concurrency-tested).
  - **`inventory`** table — but STALE: "unlock-only", unique `(user, car)`, no dupes.
  - deposits / withdrawals; rounds (largely superseded by on-chain ER).
- **Client ↔ server:** `core/api.ts` (base `VITE_API_BASE`, default `:8080`) is wired **only** for wallet-binding + round-sync today — coins/cars/scrap never touch it.
- **Scrap:** absent from the server schema — net-new.

## Architecture

**Identity.** The Privy embedded wallet is the account key. On any device, the same Privy login yields the same wallet address, which signs the server's nonce challenge → the same `users` row. Guests (walletless practice) have no account; their state stays local until they sign in.

**Data homes (this slice):**

| Data | Home | Notes |
|---|---|---|
| coins | server ledger, asset `coin` | already modeled |
| scrap | server ledger, asset `scrap` **(new)** | soft, **non-tradable**; grades already bank to one integer total |
| owned cars (counted) | server `inventory`, extended to a **count** | reconcile the stale unlock-only model |
| finishes / skins / upgrade levels | server account state | part of the garage save; synced for completeness |
| real money (`cash`) | server ledger + on-chain | unchanged |

The localStorage stores become a **cache + offline fallback**; the server is the source of truth when signed in.

## Workstream A — Cross-platform Privy build

1. **Privy login inside the Seeker APK WebView — the real risk.** Email/SMS one-time-code login is WebView-safe; social (Google) OAuth is commonly blocked in embedded WebViews (`disallowed_useragent`) and must open in the system browser (Capacitor Browser / Android Custom Tabs) or be restricted to OTP. **Must be proven on the actual Seeker.**
2. **Shell branding** — `capacitor.config.ts` appName + manifest → "Perps Rider" (drop stale "Redline 3D").
3. **Perf** — validate `platform/perf.ts` `detectQuality()` low tier on the Mali-G615; tune pixelRatio / bloom if frame-rate needs it.
4. **iPhone PWA** — Add-to-Home-Screen, full touch loop, Privy login on iOS Safari.

## Workstream B — Server-account migration (minimal)

1. **Auth wiring** — on Privy connect, run the nonce-challenge sign-in (`src/auth/wallet-binding.ts`) and hold the session token in `core/api.ts`. Guests skip it; sign-in triggers it.
2. **Scrap ledger asset** — add `scrap` to the `ledgerAsset` enum + a Drizzle migration; credit reason for driving-earn, debit reason for Scrap-Yard-spend.
3. **Counted inventory** — extend server `inventory` to a per-`(user, car)` count; grant / melt endpoints matching `core/inventory.ts` semantics (grant returns 0→1 as a NEW unlock; melt sheds a spare but never the last copy).
4. **Client rewiring** — the `Upgrades` store (coins/scrap/finishes/levels) and `Inventory` (cars/skins) read/write through `core/api.ts` when signed in; localStorage stays as the cache/offline layer.
5. **First-bind migration** — on first sign-in: if the server account has **no game-state**, **seed it from the local save** (never wipe the player's local progress); otherwise the server is authoritative and local becomes cache. **Never sum local + server** (double-credit guard).
6. **Offline / server-down** — the game stays playable on the local cache; best-effort writes reconcile on reconnect (server wins on next load).

## Sync & conflict semantics

- **Signed in, online:** server = source of truth; local = write-through cache.
- **Signed in, offline:** play on cache; reconcile on reconnect.
- **Guest:** local only; on sign-in → first-bind migration (seed-if-empty).
- **Coins/scrap integrity:** client sends *deltas* ("earned N", "spent N") as ledger entries — never client-set absolute totals — so a tampered client can't mint balance and races can't double-credit.

## Testing (TDD)

- **Server:** scrap ledger (credit/debit/balance), counted inventory (grant / dupe / melt / keep-last), auth binding, concurrency (reuse `ledger.concurrency.test.ts` harness).
- **Client:** api wiring for coins/scrap/inventory, first-bind seed-if-empty, offline cache fallback, guest→sign-in migration.
- **Cross-device (logical):** two clients, same Privy identity → converge on server state.

## Verification (on-device — the real gate)

- **Desktop:** Claude Preview — full loop; coins/scrap/cars persist to server; a second browser on the same Privy account converges.
- **iPhone PWA (user runs):** install to home screen, login, play, verify state matches desktop.
- **Seeker APK (user runs):** install, **prove Privy login works in the WebView**, play, verify same account/state as desktop; acceptable frame-rate.
- Deliver an **on-device checklist** doc so each device is walked through the same steps.

## Open decisions (taken now; adjust in review)

- **Scrap = ledger asset** (not a separate table) — reuses the concurrency-safe delta pattern.
- **First-bind = seed-if-server-empty, else server-wins** — no summing.
- **WebView login = OTP-first**, system-browser OAuth only if social sign-in is required — proven on the Seeker.
