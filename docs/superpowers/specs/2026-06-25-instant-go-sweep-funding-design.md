# Instant GO via Sweep-to-Ledger Funding — Design

**Date:** 2026-06-25
**Branch:** `real-money-rails`
**Status:** Design — awaiting review

## Problem

Pressing **GO!** is slow (≈5–12s happy path, up to 30–45s worst case) and sometimes fails with
"Payment not approved." Root cause: the recent "play directly from Privy wallet" pivot puts a **full
on-chain USDC transfer on the critical path of every round that needs a top-up**
(`main.ts:502–615` → `ensurePlayPayment` → `pay(shortfall)` → Privy sign + broadcast + a 12×1.5s
confirm poll + a 45s client-sign fallback), all *before* `roundSync.open()`. `pay(shortfall)` tops up
exactly one stake, so the common case re-pays on-chain every round.

A per-round on-chain payment can never feel instant — Solana is floored at ~0.6s `confirmed` /
~13s `finalized` (verified: deep-research wf_802cbe4c, 24 sources / 25 claims / 0 refuted). The fix is
architectural, not a tuning knob.

## Decision

**Off-chain sweep model.** Decouple funding from playing. The player moves money into an off-chain
**play balance** (the existing `cash` ledger) once, then every round is an **instant ledger debit**.
On-chain transactions happen only at the edges (fund / withdraw).

Chosen over fully-on-chain settlement because off-chain is both **faster** (sub-ms ledger write vs
~0.6–2s/leg on-chain) and **more secure** for this product (patchable + reversible + owner-reclaimable
treasury vs an unaudited custom Anchor perp engine whose entire TVL is drainable by anyone,
permanently — catastrophic at up to 2000× leverage via oracle manipulation). This is consistent with
the already-locked "engine + custody stay off-chain" decision (21-agent adversarial review,
`magicblock-decision`). The "users can verify we didn't cheat" property is deferred to on-chain
**anchor proofs** (roadmap Pillar I), which gets the trust benefit without putting funds behind
immutable code.

## Design

### 1. Funding = one sweep (whole-wallet)
A player-initiated **"Add to play balance"** action moves the **entire** Privy-wallet USDC balance into
the play balance:

1. Read wallet USDC via `GET /v1/wallet/usdc-balance`.
2. Build the transfer via `POST /v1/deposit/build` (`amountCents` = full wallet USDC) — the **proven**
   deposit rail (user wallet → treasury), *not* the play-payment rail.
3. Sign + send **once** with Privy (`signAndSendTransaction`, client-side; an approval prompt here is
   acceptable — it's a deliberate deposit, not per-round friction).
4. The **watch-and-credit** worker detects the transfer at **`confirmed`** commitment (~1–2s) →
   credits the `cash` ledger, then re-checks at finality and reverses (append-only) only if it never
   roots — safe for a self-deposit at tiny caps. (Today the worker waits for `finalized` ≈ 13s; this
   change lowers the sweep credit to `confirmed`.)
5. Client polls `GET /v1/me` until the play balance reflects the credit (~1–2s), then updates the HUD.

Player controls risk by how much they keep in the wallet (matches "user sets their own limits";
`build-only-what-asked-no-risk-scaffolding`). Gas is paid in SOL, so sweeping *all* USDC is safe.

### 2. GO = pure instant ledger debit
Remove the entire per-round on-chain charge block from `controls.onLaunch` (`main.ts:502–615`). New flow:

- Re-entrancy / sign-in / connected / dangling-round-reconcile guards stay.
- If `serverBalance >= playAmount` → `roundSync.open()` immediately → launch. **Zero on-chain, zero
  Privy, <50ms.**
- If `serverBalance < playAmount` → do **not** charge. Set status "Add USDC to your play balance to
  race" and open the wallet page focused on **Add to play balance**.

### 3. Delete the per-round play-payment rail
- **Server:** remove the 8 `/v1/play/payment/*` routes (`routes.ts:177–326`) and the now-orphaned
  units `services/play-payment-charger.ts`, `services/play-payment-broadcaster.ts`,
  `services/play-payments.ts` confirmer + their wiring in `index.ts` (all untracked / recent — clean
  removal). Keep `/v1/deposit/*`, `/v1/wallet/usdc-balance`, `/v1/withdraw`, `/v1/round/*`, `/v1/me`.
- **Client:** remove `core/play-payment.ts` (`ensurePlayPayment` + `PlayPaymentConfirmationError` +
  `PaymentSigningTimeoutError` + the server-charge error helpers) and the `playPayment*` methods from
  `core/api.ts`. Keep `InsufficientWalletBalanceError` (repurposed for the sweep). Keep `depositBuild`,
  `walletBalance`, `me`.

### 4. Withdraw = ledger → wallet
Unchanged. Existing withdraw rail (`/v1/withdraw`, staging send-leg) is out of scope for this change.

### 5. Privy demoted to the edges
Auth (unchanged) + signing the funding sweep + receiving withdrawals. Never on the per-round path.
Fully removing Privy (external-wallet deposits + replacement auth) is explicitly **out of scope** — a
separate, larger effort.

## Components / files touched

**New (client):**
- `core/play-funding.ts` — pure, testable sweep unit: given wallet balance + the api ports, build →
  sign → confirm-by-polling; returns the new play balance or throws `InsufficientWalletBalanceError`
  (wallet empty) / a typed confirm-timeout. No DOM.

**Changed (client):**
- `ui/wallet.ts` — add an "Add to play balance" button + busy/error states; calls `play-funding`.
- `main.ts` — rip out the `onLaunch` charge block; add the short-balance → open-wallet branch; wire the
  wallet's add-to-play action; drop `play-payment` imports.
- `core/api.ts` — remove `playPayment*` methods.

**Removed (client):** `core/play-payment.ts` (+ its test).

**Changed (server):** `http/routes.ts` (remove `/v1/play/payment/*`), `index.ts` (remove charger/
broadcaster/confirmer wiring), `env.ts` (drop now-unused play-payment env if any).

**Removed (server):** `services/play-payment-charger.ts`, `services/play-payment-broadcaster.ts`,
`services/play-payments.ts` (+ their tests).

## Data flow

**Fund:** wallet USDC read → `/v1/deposit/build` → Privy sign+send → on-chain transfer → watch-and-credit
→ `cash` ledger credit → client polls `/v1/me` → HUD.

**Play (GO):** `serverBalance >= stake`? → `/v1/round/open` (ledger debit, conserved house split) →
launch. No wallet, no chain.

**Cash out:** `/v1/withdraw` (unchanged).

## Error handling
- **Wallet empty on sweep** → `InsufficientWalletBalanceError` → "Add USDC to your wallet first" + show
  deposit address.
- **Sweep sign rejected / fails** → surface a specific message (not the old catch-all "Payment not
  approved"); leave play balance untouched; safe to retry (idempotent on tx).
- **Sweep sent but credit not yet seen** → "Funds on the way — they'll appear shortly"; watch-and-credit
  is idempotent on `txSig`, so a retry never double-credits.
- **GO while short** → "Add USDC to your play balance to race" + open wallet; never charges.

## Testing
- `play-funding` unit: covers full-balance sweep, empty-wallet rejection, confirm-by-poll success, and
  confirm-timeout (fake api ports + injected delay) — no network, no DOM.
- `main.ts` GO path: balance-covers → opens round with no payment call; balance-short → opens wallet, no
  round, no charge (assert via existing round-sync/api fakes).
- Server: delete play-payment tests; assert `/v1/play/payment/*` 404s; deposit/round/withdraw suites stay
  green.
- Gate: `tsc` clean, full client + server suites green, then **verify in the browser** (load redline3d in
  Claude Preview: short GO opens wallet; after a (sim/dev) credit, GO opens a round with no on-chain wait)
  before claiming done (`verify-ui-in-browser-before-done`).

## Out of scope (deliberate)
- Dropping Privy entirely (external-wallet deposits + new auth) — separate effort.
- Fully-on-chain settlement / Anchor program — rejected (slower + less secure here).
- On-chain anchor proofs (Pillar I) — the trust story, later.
- WebSocket signature-confirm for the sweep (the `rpcSubscriptions` already wired in
  `privy-island.ts:15`) — nice-to-have; sweep is off the hot path, polling is fine for v1.
- Auto-sweep on deposit detection — explicit button for v1.
- Partial/custom sweep amounts — whole-wallet for v1 (YAGNI).

## Open implementation questions
1. **Sweep gas / fee-payer.** `/v1/deposit/build` uses the tx builder's default fee-payer. Confirm
   whether the Privy wallet pays SOL gas (needs a little SOL) or the treasury sponsors it
   (`feePayer: "treasury"`, flagged UNVERIFIED in Phase-0). Resolve during the plan; worst case the
   wallet holds a touch of SOL (the model already funds the vault ~0.03 SOL).
2. **Sweep confirm commitment.** Target is crediting at `confirmed` (~1–2s) with finality
   reconciliation, vs the current deposit worker's `finalized` (~13s). The plan must verify whether to
   lower the shared deposit worker's commitment or add a sweep-specific confirmed-path, and confirm the
   append-only reversal fires if a confirmed-but-credited tx never roots. Optimistic-on-send (~instant)
   is the faster alternative if the user wants zero wait. This is the one money-safety knob in the
   change — `confirmed` for a tiny self-deposit is the recommended default.
