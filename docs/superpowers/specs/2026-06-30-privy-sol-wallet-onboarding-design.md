# Privy embedded wallet + SOL stakes — onboarding slice (design)

**Date:** 2026-06-30
**Branch:** `onchain-er-rebuild`
**Status:** design — pending spec review before writing-plans
**Predecessor:** the multi-asset slice (`2026-06-29-multi-asset-onchain-feed-registry-design.md`) made BTC/ETH/SOL playable on-chain, driven by a **dev-keypair** `SolanaWalletPort`. This slice replaces the dev keypair (for real users) with a **Privy embedded wallet** and switches the stake currency to **SOL**, to make a brand-new player's time-to-first-play as short as possible.

## Goal

A brand-new user with **no crypto and no wallet** can: **sign in with email/social → get an embedded wallet instantly → fund it with SOL → play a real on-chain round → cash out**, with **zero per-transaction popups** during play. Stakes are **0.01–0.1 SOL**. Devnet-first; the deployed `raider` program is **unchanged** (it stays mint-agnostic — SOL rides in as wrapped SOL).

This **reverses the 2026-06-27 deep-research custody verdict** (which chose self-custody Phantom/MWA over an embedded provider). Decision owner accepted the trade: Privy puts a managed-wallet provider in the path (softens strict non-custodial) in exchange for best-in-class mainstream onboarding. The non-custodial *withdraw* invariant is preserved where it matters (see Custody below).

## Decisions (locked with the user)

- **Wallet:** Privy **embedded** wallet (email/social login, no seed phrase). Reverses the self-custody direction.
- **Currency:** **SOL**, via **invisible wrapped-SOL (wSOL)** — the program is untouched; the client wraps/unwraps behind the scenes. USDC is a later swap-the-mint change.
- **Bet sizing:** **0.01–0.1 SOL** per round (~$0.75–$7.50 at SOL ≈ $75).
- **Zero-popup signing:** preferred **Option A** (client-side `useSignTransaction`, no confirmation UI, no server); **Option B** (server delegated signing) is the fallback. Resolved by **Task 0**.
- **Keep the dev-keypair port** as the automated/Claude-Preview path; Privy is the real-user path, selected by config. Privy login can't be driven in Preview, so the Privy path gets a **manual pass by the user**.

## Architecture

The `redline3d/src/chain/` layer already abstracts the wallet behind **`SolanaWalletPort`** (`connect` / `signMessage` / `signTransaction(base64)` / `currentAddress`). This slice adds a **second implementation** of that port and a stake-currency change; the `chain-round` / `game-session` orchestration is otherwise untouched.

```
Privy React island (PrivyProvider + login)  ──bridge──▶  PrivyWalletPort : SolanaWalletPort
                                                              │  signTransaction(base64) = Privy embedded-wallet sign (Option A)
                                                              ▼
       main.ts ─▶ game-session ─▶ chain-round (build tx + HTTP-poll broadcast to ER/L1)
                                      │
                                      ├─ buy_in/withdraw now move **wSOL** (mint = So111…112)
                                      └─ client wraps SOL→wSOL before buy_in, unwraps on withdraw
```

### Task 0 (gating spike) — zero-popup signing mechanism

`open`/`flip`/`lever`/`close` fire several ER txs per round. If Privy pops a confirmation modal per tx, the game is unplayable (this is the real thing that was mislabeled "Privy jank"). Spike, in priority order:

- **Option A — client-side silent signing (preferred, no server).** A Privy embedded wallet signs via `useSignTransaction` (`@privy-io/react-auth/solana`) with the embedded-wallet confirmation UI disabled (`PrivyProvider` `embeddedWallets.showWalletUIs: false` / per-call `uiOptions`). If a sequence of ER txs signs with no modal, **Option A wins** — no backend, signing stays client-side, and it drops straight into the existing `signTransaction(base64)` port (Privy signs the bytes, our existing HTTP-poll `send()` broadcasts).
- **Option B — server delegated signing (fallback).** User calls `delegateWallet` (one consent) → the app's **server** signs via Privy's Node SDK + app secret. Proven zero-popup, but adds a server to the signing path and softens custody. Requires routing unsigned txs to the server — a larger detour from the current client `send()`.

**Record the decision** (`RESOLVED <date>: Option A/B`) in this spec before building the port. The rest of the slice is identical either way except where the signature comes from.

**BUILT FOR Option A (2026-06-30):** against the installed `@privy-io/react-auth@3.32.2`, the island (`src/chain/privy-island.ts` — plain `.ts`, no JSX, so no `jsx` tsconfig flag / React-Vite-plugin) mounts `PrivyProvider` with `embeddedWallets: { solana: { createOnLogin: "users-without-wallets" }, showWalletUIs: false }` — `showWalletUIs:false` is the SDK's documented per-signature-prompt suppressor (`index.d.ts:1084` "the signature will [not prompt]"). Signing is **sign-only** via `useSignTransaction` (`@privy-io/react-auth/solana`), returning the signed wire bytes for our existing HTTP-poll `send()` to broadcast — so the provider needs **no RPC/cluster config** (dropped the old `@solana/kit` `rpcs` block). tsc-clean against real SDK types; the build/no-regression of the default dev-keypair path is verified. **The decisive zero-popup proof (a real login + a sequence of ER signs with NO modal) can only be confirmed by the Task-10 manual user pass** — Privy email/social login can't be driven in Claude Preview. So Option A is *implemented and type-correct*, pending that one manual confirmation; if a modal appears per tx, fall back to Option B.

## Components

### New — Privy wallet port (`redline3d/src/chain/`)
- **`privy-island.tsx`** (React) — a small React root hosting `PrivyProvider` (appId from env, `solana` RPC config, `embeddedWallets.createOnLogin: 'users-without-wallets'`, confirmation UI off). Exposes login state + the embedded wallet + a `signTransaction` callback to the vanilla app via a tiny event/promise bridge. Resurrects the pre-removal `privy-island.ts` pattern, adapted for Solana embedded signing. (Brings back `react`, `react-dom`, `@privy-io/react-auth`.)
- **`privy-wallet-port.ts`** — `createPrivyPort(): SolanaWalletPort`. `connect()` triggers Privy login + ensures an embedded wallet, returns its address; `signTransaction(base64)` round-trips through the island's signer; `currentAddress()` returns the embedded wallet pubkey. Same interface the dev-keypair port satisfies.
- **`wallet-select.ts`** (or extend `loadSolanaWalletPort`) — pick the port by config: `dev-keypair` for local/Preview/tests, `privy` for the real build (env flag, e.g. `VITE_WALLET=privy`).

### Stake currency — wSOL (`redline3d/src/chain/`)
- **`config.ts`** — `TEST_USDC_MINT` → a `STAKE_MINT` pointed at **wSOL `So11111111111111111111111111111111111111112`**; `USDC_DECIMALS` (6) → `STAKE_DECIMALS` (9). (Keep the field meaning; rename for clarity.)
- **`wsol.ts`** — `wrapSol(amountLamports)` (create the wSOL ATA if absent + `SystemProgram.transfer` lamports into it + `syncNative`) and `unwrapSol()` (`closeAccount` the wSOL ATA → lamports back to owner). Both are owner-signed (Privy/dev port). Idempotent ATA handling.
- **`chain-round.ts` / `game-session.ts`** — `ensureSession`/`buyIn` wrap the buy-in amount first; `withdraw`/`endSession` unwrap after. No settle-math change (currency-agnostic).

### Game (`redline3d/src/main.ts`, `src/ui/`)
- **Stake control** — play amount becomes **0.01–0.1 SOL** (was $/cents). Show the SOL amount with a **USD-equivalent off the live SOL feed** we already wired. `BUY_IN_BASE` and the per-round stake move to lamports.
- **Onboarding entry** — a "Sign in to play" CTA (Privy) for the real build; the dev build keeps the silent dev-keypair. A **"Get test SOL"** affordance on devnet (faucet/operator transfer) so a fresh wallet can fund itself.

### Operator (`redline3d/scripts/`)
- **`bootstrap-devnet.mjs`** — also bootstrap a **wSOL-mint house** (`init_house`/`fund_house` against `So111…112`, funded with a few wrapped SOL to cover the 0.1-SOL × 23.75 max-payout pre-lock). The feed registry is unchanged (price feeds are orthogonal to the stake mint).
- **`fund-wallet.mjs`** — transfer native SOL to a target wallet (the Privy embedded wallet's address) for devnet testing.

## Data flow (the funnel)

1. **Land → Sign in** (email/social) → Privy embedded wallet created (~30s, no seed phrase). Its pubkey = the player.
2. **Fund** → user holds **native SOL** (devnet: faucet/operator transfer; mainnet later: buy/bridge).
3. **GO** → client (Privy-signed, no popup): `wrapSol(stake)` → `buy_in(wSOL)` → `delegate` → `open(asset)` → crank armed. Round plays; settles via crank/close.
4. **Cash out / End** → `commit_and_undelegate` → `withdraw(wSOL)` → `unwrapSol()` → native SOL back in the wallet.

Player only ever sees SOL. wSOL exists for the few seconds the program needs an SPL token.

## Custody note

Option A keeps signing **client-side** (the embedded wallet, in Privy's iframe, signs locally) — closer to non-custodial than the old Privy *server-wallet* model. `withdraw` is still **owner-signed and re-derives the PDA from the signer**, so funds can only ever return to the wallet that owns them. The softening vs. self-custody is that Privy (not the user's own extension) manages the embedded key. This is the accepted trade for onboarding speed.

## Error handling

- **Privy not configured / login fails** → fall back to a clear "couldn't sign in" state; dev build is unaffected (dev-keypair).
- **Per-tx popup appears in the spike** → Option A failed → switch to Option B (documented), or gate the round to one batched signature where possible.
- **Insufficient SOL to wrap** (stake + ATA rent + fees) → "add SOL to play" before `wrapSol`.
- **wrap/unwrap partial failure** → wrap is idempotent (reuse existing wSOL ATA); unwrap closes whatever wSOL ATA exists; never block withdraw on unwrap (worst case the user holds wSOL and can unwrap later).
- All Slice-1/3/4 + multi-asset gotchas remain (HTTP-poll confirm, ownership-poll delegate, `entryRaw·10^(-expo)`, `round.feed` validation, one-session-per-mint house wedge).

## Testing / verification

- **Task 0 spike** — the decisive proof: a sequence of ER signatures with no popup (Option A) or via delegated server (Option B).
- **Unit** — `privy-wallet-port` (mock the island bridge: connect/sign/address conform to `SolanaWalletPort`); `wsol` wrap/unwrap amount + ATA logic; stake-amount (SOL↔lamports, 0.01–0.1 clamp).
- **Gated devnet integration** (`chain-round.devnet.test.ts`, dev-keypair port) — full loop against the **wSOL house**: wrap → buy_in → delegate → open → close → undelegate → withdraw → unwrap, **conserved in lamports**. This proves the wSOL custody path without needing Privy.
- **Claude Preview** (dev-keypair build) — the real game plays a **SOL** round end-to-end (wrap/unwrap invisible, stake 0.01–0.1, USD-equivalent shown), per [[verify-ui-in-browser-before-done]]. This verifies everything *except* Privy login.
- **Manual Privy pass (user)** — the one thing Preview can't do: the user signs in with email, funds with SOL, plays a round zero-popup, withdraws. I prep it and hand off; the user confirms.

## Risks

1. **Zero-popup signing (Task 0)** — the gate. Option A may show a modal per tx → fall back to Option B (server) with the custody/complexity cost. *Resolve before building the port.*
2. **React back in a vanilla app** — Privy is React; the island adds `react`/`react-dom`/`@privy-io/react-auth` (which the privy-removal stripped). Mitigated by resurrecting the proven island pattern; isolated to the island file.
3. **Privy not Preview-testable** — accepted; dev-keypair port carries automated/Preview verification, Privy gets a manual pass.
4. **wSOL decimals (9) + rent** — amounts get bigger; the temporary wSOL ATA costs ~0.002 SOL rent (refunded on unwrap). Settle math is decimals-agnostic.
5. **Devnet SOL faucet flakiness** — operator-funds the test wallet (we already do this).

## Carry-forward (not in this slice)

- **USDC** — swap `STAKE_MINT` back to a USDC mint + drop wrap/unwrap; the program is already mint-agnostic.
- **Mainnet** + fiat on-ramp (Privy's card→SOL), account recovery, social-login variety.
- The divergence-free **lever keeper** (deferred earlier), removing the dead **off-chain deposit path** from `main.ts`, **Phase-3 house sharding** (the one-session-per-mint wedge).
- Session keys for a *self-custody* path (Phantom/MWA/Seeker) remain a separate future option behind the same port.
