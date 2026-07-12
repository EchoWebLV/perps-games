# Real-Money Rails — Design Spec

**Status:** Design (approved direction; hardened by adversarial review). Awaiting user sign-off before plan.
**Date:** 2026-06-23
**Branch:** `real-money-rails`
**Pillar:** Real-money USDC deposit / withdraw / treasury for Perps Rider (codename redline).

> This design was hardened by a 66-agent adversarial security review (run `wf_abc2e8bd-0aa`): 56 confirmed findings (9 critical / 14 high / 21 medium / 12 low), 15 must-fixes, 18 completeness gaps. Every must-fix is folded into the design below, not appended. Where the review flagged a capability as **unverified-against-code**, it is called out explicitly and gated behind Phase 0.

---

## 1. Goal & scope

Build the rails that move real USDC **in** (deposit) and **out** (withdraw) of a fully-reserved, server-held treasury, with an off-chain ledger that is provably solvent at all times.

**The defining constraint — money moves, but is NOT yet at risk in the game.** Deposited USDC sits as a withdrawable `cash` balance. Rounds continue to stake soft `coin`. So we ship "real money in and out, reconciled" *without* exposing a cent to the unhedged 500×–2000× game risk (which memory records inverts house EV to −50%/−74%/−92% in vol spikes). Flipping rounds to stake `cash` is a **separate future flag**, fail-closed unless the 1.4 autonomous settler + per-leverage/aggregate risk throttles + the FlashTrade net-exposure hedge are all live. **This pillar's ship is decoupled from that flip.**

### In scope
- `cash`/`coin` asset seam in the ledger (asset-aware balances, locks, idempotency).
- Deposit flow (user's Privy embedded "game wallet" → treasury, treasury-sponsored gas).
- Withdraw flow (treasury → the user's recorded/funding-source wallet only).
- Treasury custody (Privy **quorum-owned** server wallet), key management, hot/cold posture.
- Confirmation worker (durable, leased, multi-replica-safe).
- Reconciliation & solvency guard with an automatic kill-switch.
- Anti-abuse & compliance controls (anti-rinse, sybil, AML/KYC posture — at least documented decisions).
- Migration tooling, observability, runbook, admin/dispute tooling.

### Explicitly OUT of scope (this pillar)
- Rounds staking `cash` (real money at risk in gameplay). Gated behind 1.4 + throttles + hedge.
- Fiat on-ramp UI itself (we lean on Privy's on-ramp / "send USDC to your game wallet"; we don't build a card processor).
- The soft-coin economy redesign (Garage/Upgrades/Crates) — separate pillar.

### Locked decisions (from brainstorming)
- **Network/asset/posture:** Solana **mainnet**, **USDC**, real from day one, behind **tiny hard caps** ($1–5) during hardening.
- **Custody:** treasury = Privy **server wallet** (key in Privy TEE; we never hold a raw private key), **hardened to quorum-owned** (≥2-of-n, ≥1 key off-host) per review.
- **Deposit UX:** the user's Privy **embedded** wallet is their "game wallet"; deposit moves USDC game-wallet→treasury, treasury **sponsors gas** (user needs no SOL); withdraw mirrors back to the **same bound wallet** (the allowlist).

---

## 2. Threat model & trust boundaries

The single most important review insight: **all four app-side withdraw locks (dest = bound wallet, amount ≤ cash, daily caps, quorum) run inside handlers that an RCE / leaked-`PRIVY_APP_SECRET` attacker fully controls — they are bypassed by simply not calling them.** And `PRIVY_APP_SECRET` (already in `env.ts` for token verification) doubles as the treasury-drain key if the treasury is app-secret-signable.

Therefore the **only real boundary is Privy-side policy enforced by a key the app server cannot reach.** The design is built around that:

| Control | Survives app-server compromise? |
|---|---|
| Dest = bound wallet (app code) | ❌ honest-server-only |
| Amount ≤ cash / daily caps (app code) | ❌ honest-server-only |
| **Privy per-tx cap + recipient + program + rolling-window aggregate policy** (separate policy key) | ✅ yes |
| **Quorum (≥2-of-n, ≥1 approver key off-host)** | ✅ yes |
| **Hot float only on-chain; bulk in cold/quorum reserve** | ✅ yes (bounds max loss) |
| Separate JWT-verify credential from treasury-signing credential | ✅ reduces blast radius |

**Design rule:** app-side locks are the *honest-path* UX/safety layer; Privy policy + quorum + the hot/cold split are the *adversarial* boundary. We assume the app server can be fully compromised and ensure the worst case is "drain the small hot float to users' own bound wallets," never "arbitrary destination, unlimited amount, or the cold reserve."

---

## 3. The `cash` / `coin` seam (hardened)

The existing ledger (`server/src/services/ledger.ts`) sums `delta` over **all** rows with **no asset filter**, serializes on a **userId-only** advisory lock, swallows conflicts via `.onConflictDoNothing()` **with no rowcount check**, and indexes idempotency on `(reason, ref)` with **nullable `ref`**. As-is, a withdraw reserve reusing `debitOn` would pass against `coin + cash` combined — the $100 signup-faucet coin becomes withdrawable USDC = instant insolvency. The seam must be enforced, not defaulted:

1. **Add `asset` to `ledgerEntries`** as `pgEnum('coin','cash') NOT NULL`, `DEFAULT 'coin'` **for the backfill migration only**.
2. **Make `asset` a REQUIRED positional param (no default)** on every ledger primitive — `balanceOn`, `debitOn`, `creditOn`, `post`, `credit`, `canAfford`. This forces **every existing call site to fail to compile** (`routes.ts:48,60,63,119,151`; `rounds.ts:55,204`) until each explicitly passes `'coin'` — a compiler-driven audit.
3. **`balanceOn`** adds `and(eq(userId), eq(asset))`; **`debitOn`** threads `asset` into its own balance check **and** stamps the inserted row's `asset`.
4. **Advisory lock key includes asset:** `pg_advisory_xact_lock(hashtextextended(userId || ':' || asset, 0))`, so a `cash` debit can't be admitted under a stale cross-asset balance held by a `coin` writer. *(See §3a for the contention/correctness reconciliation.)*
5. **Idempotency index → `UNIQUE(asset, reason, ref) WHERE ref IS NOT NULL`** (was `(reason, ref)`), so a `cash` and a coincidental `coin` entry sharing `(reason, ref)` can't silently drop each other.
6. **Forbid null `ref` for cash-moving reasons:** DB `CHECK (ref IS NOT NULL OR reason NOT IN ('deposit','withdraw_reserve','withdraw_reverse'))` **and** in-code throw in `creditOn`/`debitOn` if a cash reason has null/empty `ref`. (A null-`ref` deposit credit otherwise bypasses idempotency entirely → one transfer credits twice.)
7. **`debitOn` returns whether it actually debited:** `.onConflictDoNothing().returning({id})` → boolean (mirrors the existing `inventory.grant` idiom). A replayed `(withdraw_reserve, withdrawalId)` is currently swallowed silently while the caller proceeds to send USDC — **a replayed withdrawal reserves $0 yet sends.** The irreversible send must gate on this boolean.

### 3a. Lock scope reconciliation (gap H)
The lock and the balance check must guard the **same scope**. Decision: **lock per-`(userId, asset)`** (so cash withdraws don't block coin play and vice-versa) with the balance read **asset-filtered to match**. A concurrency test exercising simultaneous `coin`-stake + `cash`-withdraw on one user proves race-freedom. (Alternative — keep per-user lock serializing all money moves — rejected for contention; the per-asset lock is correct as long as no operation ever touches both assets atomically, which none does.)

### 3b. `L` definition
`L` (our liability) `= SUM(delta WHERE asset='cash')` across all users, **exclusively**. The faucet/`coin` economy never counts toward USDC backing.

---

## 4. Data model

### `ledgerEntries` (existing, extended)
`+ asset pgEnum('coin','cash') NOT NULL DEFAULT 'coin'`; idempotency index → `(asset, reason, ref)`; CHECK on null ref for cash reasons (see §3).

### `deposits` (new)
`id (uuid pk), userId, amountCents (bigint), status ('preparing'|'submitted'|'confirmed'|'failed'|'expired'|'quarantine'), txSig (text UNIQUE, nullable), messageHash (text — SHA-256 of the server-authored tx message, see §5), expiresAt (timestamptz — prepare TTL), leaseOwner (text), leaseExpiresAt (timestamptz), attempt (int default 0), createdAt, updatedAt`.
Credit idempotent on `(asset='cash', reason='deposit', ref=txSig)` — **never `depositId`**.

### `withdrawals` (new)
`id (uuid pk, SERVER-generated — never client-supplied), userId, amountCents (bigint), destWallet (text, snapshotted from the bound/funding wallet), status ('reserved'|'signing'|'sent'|'confirmed'|'failed'|'reversed'|'awaiting_approval'|'needs_review'), txSig (text, nullable), privyTxId (text, nullable), privyIdempotencyKey (text NOT NULL = 'withdraw:'||id), intentId (text, nullable), approvalExpiresAt (timestamptz, nullable), approvalNonce (text, nullable), leaseOwner, leaseExpiresAt, attempt (int default 0), createdAt, updatedAt`.
Debit idempotent on `(asset='cash', reason='withdraw_reserve', ref=id)`; reversal on `(asset='cash', reason='withdraw_reverse', ref=id)`.
**Partial unique index** `withdrawals(userId) WHERE status IN ('reserved','signing','sent','awaiting_approval','needs_review')` → at most one in-flight withdrawal per user (a second concurrent reserve 409s).

### `deposit_sources` (new — append-only allowlist)
`id, userId, sourceWallet (text), firstSeenTxSig, createdAt`. Records the **parsed on-chain source owner** of each confirmed deposit. Withdrawals bind their destination to a confirmed deposit source here, **not** the live mutable `users.walletPublicKey` (see §6, §9).

### `users` (existing — hardened)
`walletPublicKey` becomes **set-once**: `setWalletPublicKey` → compare-and-set `UPDATE ... WHERE id=$id AND wallet_public_key IS NULL RETURNING`; if 0 rows and existing differs, do **not** overwrite — alert `wallet_rebind_attempt`, return existing. `fetchSolanaWallet` becomes deterministic (earliest-created embedded Solana wallet; alert on >1; the current `.find()` at `privy.ts:39` is non-deterministic).

---

## 5. Deposit flow (server is the SOLE tx author)

1. **`POST /v1/deposit/prepare {amountCents}`** — under the global+per-user lock, validate cap and that a bound wallet exists; **reserve deposit headroom** counting in-flight `preparing|submitted` rows; build the **full single `transferChecked` tx** from server-trusted inputs only (source = recorded wallet's USDC ATA, dest = the *one* canonical derived treasury ATA, mint = `USDC_MINT`, decimals = 6, fee-payer = treasury, **server-chosen capped compute budget**, server-fetched blockhash). Persist the **exact serialized message bytes / SHA-256** on the row with an `expiresAt` TTL. Return the serialized tx.
2. **Client signs** the source authority with the Privy embedded wallet → **`POST /v1/deposit/submit {depositId, signedTx}`**.
3. **Server enforces EXACT message equality** — take **only the user's 64-byte signature** off the returned tx and graft it onto the server's *stored* message; verify the signature against `(stored message, user pubkey)`; **reject if message bytes ≠ stored.** Assert `accountKeys[0] == treasury` and treasury is signer **only** in the fee-payer role (never an instruction authority). This blocks the client appending a second transfer / CPI / memo / extreme-priority-fee `ComputeBudget` ix that the treasury would otherwise pay for. Attach treasury sig, submit. Reject if the re-derived signature already maps to a **different** `depositId`.
4. **Confirmer credits ONLY after `finalized`** and a parse of **this tx's own `meta.pre/postTokenBalances`** for the canonical treasury ATA (matched by `accountIndex`, **not** a live balance snapshot — that cross-credits concurrent deposits). Read the **raw base-unit delta as BigInt**. Credit iff **all** hold: `BigInt(deltaRaw) === BigInt(row.amountCents) * 10000n` (exact; **dust → fail, never round**), `mint === USDC_MINT`, `programId === legacy SPL Token` (reject Token-2022), `decimals === 6`, source-account **owner === the bound wallet**, dest === the canonical derived treasury ATA. Pass `parsedCents` (= `row.amountCents` on match) into `creditOn(userId, parsedCents, 'cash', 'deposit', txSig)`. On any mismatch: **do not credit**, mark `quarantine`, alert. Record the source owner into `deposit_sources`.
   - **Two-RPC money-in quorum** (open-Q): confirm `finalized` + identical parsed delta on a **second independent provider**; plus a **delayed re-verification ~150 slots later** that posts a compensating debit if the signature no longer finalizes (bounds the theoretical finalized-rollback into a self-healing event).

**USDC scale (must-fix, gap):** one module — `BASE_UNITS_PER_CENT = 10_000n`; `centsToBaseUnits(c) = BigInt(c) * 10_000n`; `baseUnitsToCents` **throws on any non-zero remainder**. Never `uiAmount`/`Number`. **Boot assert** (when `REAL_MONEY_ENABLED`): `getMint(USDC_MINT)` → `decimals === 6` and owner program === legacy SPL Token, else refuse to start.

---

## 6. Withdraw flow (treasury → bound wallet; the money-out path)

1. **`POST /v1/withdraw {amountCents}`** — **no destination in the body** (hard-locked to the bound/funding wallet). Mint a **server-side UUID** `withdrawalId`. Inside the reserve tx, after acquiring the **global fixed-key advisory lock first, then the per-(user,cash) lock** (must-fix: caps must be enforced *inside* the reserve tx, not check-then-act): validate dest = bound wallet; `amount ≤ settled cash`; per-tx / **per-user-24h / global-24h** caps **counting in-flight rows** (`reserved|signing|sent|awaiting_approval|needs_review|confirmed`; excluding `failed|expired|reversed`); rate limit; **synchronous solvency precheck** `O_lastgood − R_inflight − amount ≥ 0`; **anti-rinse gate** (§10). Caps use a **DB-computed rolling 24h window** (`now() - interval '24 hours'`), never app/calendar clock (gap M).
2. **Reserve atomically:** `debitOn(..., 'cash', 'withdraw_reserve', withdrawalId)` → **boolean**. If `false` (replay), do **not** send — load the existing row and resume its state machine. If `true`, insert the `withdrawals` row `reserved` **and persist `privyIdempotencyKey = 'withdraw:'||withdrawalId`** in the **same tx** (before any network call).
3. **Sign + send** — transition `reserved → signing` (`WHERE status='reserved'`), then call Privy `signAndSendTransaction` with the **deterministic idempotency-key header** (and `reference_id = withdrawalId`) so a crash/timeout after broadcast can't produce a second transfer. Privy policy enforces the cap/program/recipient/aggregate. Persist `privyTxId`/`txSig`, mark `sent`.
   - **Above-threshold → `awaiting_approval` via Privy Intents** (must-fix): key-quorum needs all signatures up-front in one call (no built-in pending state), so we bind the withdrawal to `client.intents.transfer` **without** enough sigs to execute, persist `intentId`, and a **separate signing service on independent infra** (distinct P-256 key, distinct host/secret store) pulls pending intents, re-checks `intentId→withdrawal/amount/dest` under the lock, and authorizes out-of-band. Add `approvalExpiresAt` (TTL, e.g. 24h) + `approvalNonce`; the confirmer **auto-reverses expired `awaiting_approval`** rows (safe — no tx was ever submitted).
4. **Confirmer — NEVER auto-reverse on inference** (critical must-fix). From `sent` the only auto-transitions are `→confirmed` (positive `finalized` observation) or `→needs_review` (leave cash **debited**, hold, page). Reverse-credit is a **separate gated step** requiring **all** of: `getSignatureStatuses(searchTransactionHistory:true) === null` on **≥2 independent RPCs**; `getTransaction(commitment:'finalized') === null` on both; `currentBlockHeight ≥ lastValidBlockHeight + ~150`; Privy idempotency-key authoritatively reports **no tx exists**; and (during $1–5 hardening) human/quorum sign-off. **Prefer re-broadcasting the same signed tx** (idempotency-keyed) over reversing. A landed-but-**failed** tx (`status.err != null`, e.g. frozen dest ATA) is a **distinct** branch — safe to reverse immediately (no token moved). The reverse-credit asserts the matching reserve-debit row exists before posting.

**Hardening posture:** during $1–5 caps set `QUORUM_THRESHOLD = 0` → **every** withdrawal needs out-of-band approval.

---

## 7. Confirmation worker (durable, leased, multi-replica-safe)

The repo has **no background-worker infra** (only the price-feed `setInterval`), and Railway **redeploys routinely kill an in-process worker mid-advance.** Required:
- **Lease columns** on `deposits` + `withdrawals` (`leaseOwner`, `leaseExpiresAt`, `attempt`). Claim with one atomic guarded `UPDATE ... SET status=…, leaseOwner=$me, leaseExpiresAt=now()+60s WHERE id=$id AND status=$expected AND (leaseOwner IS NULL OR leaseExpiresAt < now()) RETURNING` — empty return = skip. Pick rows with `SELECT … FOR UPDATE SKIP LOCKED`.
- Combined with the **deterministic Privy idempotency key**, even a lease-expiry reclaim during a crash window can't produce a second transfer.
- **Boot-resume sweep:** on startup, re-enqueue all non-terminal `deposits`/`withdrawals`. **Graceful shutdown** drains in-flight ticks.
- `RUN_CONFIRMER` pins to one replica as belt-and-suspenders, but correctness must **not** rely on it (leasing is the real guard).
- **Rolling-deploy safety** (gap M): state-machine changes are **additive only** (new states, no in-place meaning changes) so a v1-created `reserved` row can't be mis-advanced by v2 during a rolling deploy; else quiesce money workers during deploy. Tested rollback must not orphan in-flight rows.

---

## 8. Reconciliation & solvency

Net `O ≥ L` alone under-counts exactly the crash/uncertainty cases that lose money. Required:
1. **Record-before-send** (Privy idem key + expected amount + dest persisted before the Privy call) so every outflow is enumerable from the DB before it exists on-chain.
2. **Enumerate treasury-ATA outflows 1:1:** match each on-chain outflow over a window to exactly one `withdrawals` row by `txSig`. **Page** on any on-chain outflow with no matching row, and any `signing|sent` row past TTL with no on-chain outflow.
3. **Double-pay detector:** for every `{sent,reversed,confirmed}` withdrawal, resolve its `txSig` landing via `getSignatureStatuses(searchTransactionHistory:true)` and assert `(reversed XOR landed)`. A `reversed` row whose tx **landed** is the exact double-pay signature → page directly.
4. **Recognized vs raw `O`** (gap M): the reconciler counts only **recognized deposits** as backing; unsolicited inbound transfers to the treasury ATA (airdrops/poisoning/mistakes) are **quarantined/ignored**, never counted as backing (else they mask a real deficit).
5. **Pin both reads to a finalized slot** (store each row's confirmation slot; gate `L` on it) to kill TOCTOU false pages.
6. **Auto-trip kill-switch:** on first unexplained `O < L` **or** anomalous outflow velocity, flip `REAL_MONEY_ENABLED` to read-only **in-process** (halt new prepares/sends), not just page.
7. **Solvency-at-value caveat** (gap L): `O ≥ L` is a **unit-count** invariant, not a value guarantee. Document a depeg/freeze stance (pause withdrawals / honor at par) separately.

---

## 9. Treasury custody & key management

- **Quorum-owned wallet** (`owner_id = KeyQuorum`, threshold ≥ 2), ≥1 authorization key held **off the Railway host** (HSM/KMS or a separate approver service the app cannot reach). A separate higher-privilege key is the **only** thing that can edit policy.
- **Privy policy rules** (not app code): per-tx cap, `mint == USDC`, `program == legacy SPL`, **rolling-window aggregate-spend cap**. CI-assert the treasury wallet owner **is** a quorum (fail-closed if app-secret-only).
- **Separate the JWT-verify credential from the treasury-signing credential.**
- **Hot/cold:** keep only a small **hot float** on-chain; bulk in a cold/quorum reserve the app can't move — this is the real global ceiling.
- **SOL replenishment** (gap H): a monitored SOL floor with **warn/page** thresholds, documented top-up owner + procedure, and **hard refusal-to-prepare/send when SOL < N** (explicit failure, not silent mid-flight brick).
- **ATA-creation rent** (gap L): every first-time depositor whose treasury sponsors ATA creation permanently consumes ~0.002 SOL (attacker-amplifiable). Track cumulative rent outflow + alert; decide whether the **user** bears ATA-creation rent to remove the amplifier.

---

## 10. Anti-abuse & compliance

- **Anti-rinse / AML (CRITICAL gap).** Deposit → zero-play → withdraw turns the treasury into a money-transmission/mixing rail (textbook structuring; launders dirty USDC through a "gaming" façade). Required v1 controls: a **minimum wager-to-withdraw play-through** *or* a **deposit aging/hold before first withdrawal**, a **per-identity lifetime in/out tracker**, and a documented **KYC threshold + OFAC/sanctions screening of the bound wallet + Travel-Rule/SAR posture** — even if the v1 answer is "tiny caps + manual review only." **This is a user decision (see §15).**
- **Sybil/multi-account** (gap H): per-user caps are defeated by spinning up N Privy DIDs. Enforce **per-funding-source / per-bound-wallet dedupe** (the same destination wallet can't back two accounts) and treat the **global-24h cap as the real ceiling**, not per-user. Faucet gets rate/lifetime limits keyed on something harder to forge than a fresh DID.
- **Dust-spam** (gap M): min-amount + rate-limit on `deposit/prepare` to stop confirmer/rent griefing.
- **Privy wallet recovery vs allowlist** (gap M): document what happens when the embedded wallet changes (account recovery onto a new device) — any withdraw-wallet change requires step-up verification + cooling-off before withdrawals to the new address.
- **Tax/1099 + financial export** (gap M): document a decision (even "deferred until caps lift") on reporting thresholds and a tested per-user/per-period `cash`-ledger export.

---

## 11. Config / env (all gated, all fail-closed)

`REAL_MONEY_ENABLED` (master; off → endpoints 404 + worker idle), `SOLANA_RPC_URL` + `SOLANA_RPC_URL_FALLBACK` (≥2 independent providers), `SOLANA_CLUSTER='mainnet-beta'`, `USDC_MINT` (canonical mainnet pubkey, boot-asserted), `TREASURY_OWNER_PUBKEY` + Privy wallet/quorum config, `DEPOSIT_MIN/MAX_CENTS`, `WITHDRAW_MIN/MAX_CENTS`, `WITHDRAW_USER_DAILY_CAP_CENTS`, `WITHDRAW_GLOBAL_DAILY_CAP_CENTS`, `WITHDRAW_QUORUM_THRESHOLD_CENTS` (0 during hardening), `WITHDRAW_APPROVAL_TTL`, rate-limit params, `CONFIRMATION_COMMITMENT` (boot-assert `=== 'finalized'`), `PREPARE_TTL`, `SOL_FLOOR_LAMPORTS` (warn/page), `RUN_CONFIRMER`, anti-rinse params (play-through ratio / hold).

---

## 12. Observability, runbook, admin tooling (gap H)

- **Metrics:** deposit/withdraw success + latency histograms, in-flight counts, reverse rate, **`O`/`L` gauge over time**, SOL balance, cumulative rent.
- **Append-only state-transition audit trail** for every deposit/withdrawal transition.
- **Runbook** covering: Privy outage, RPC outage mid-withdraw, SOL-dry, reconciliation deficit, stuck `awaiting_approval`/`needs_review`. Kill-switch (`REAL_MONEY_ENABLED` flip) wired to halt instantly.
- **Admin/ops surface** (gap H): audited, least-privilege, **four-eyes** actions for the legitimate manual resolutions (force-confirm after manual chain verification, manual reverse, approval release/expiry) + a user-facing support/dispute path. **No raw SQL on `ledgerEntries` in prod.**
- **Backpressure** (gap M): bounded work queue + concurrency limits for Privy/RPC calls so a burst can't starve the whole subsystem and widen timing windows.

---

## 13. Migration plan

> The completeness critic flagged "no migration tooling," but the explore pass found `server/drizzle/` (migrations 0000–0004) + `src/migrate.ts` (drizzle-kit migrator) **already exist** — the critic was wrong on this point. We use the existing pipeline.

- Add `asset` as `NOT NULL DEFAULT 'coin'` in **one transaction**; change the unique idempotency index to `(asset, reason, ref) WHERE ref IS NOT NULL`; add CHECK; add new tables + indexes. Tested **forward + rollback**.
- Deploy writers **read-compatible** with the new column **before** backfill (or briefly write-quiesce the table). A bad migration on the money table is insolvency-grade.

---

## 14. Phasing / rollout

- **Phase 0 — Privy + Solana capability verification (GATING).** Install `@privy-io/node` and inspect the `.d.ts`; **empirically prove in a Privy staging app**: server-wallet Solana `signAndSendTransaction` with idempotency-key; per-tx **policy** rejects above-cap + non-pinned-recipient with only the app secret; **key-quorum / Intents** approval lifecycle; **fee-payer sponsorship**; and whether Privy signs with a **recent blockhash or durable nonce** (decides whether blockhash reasoning is ever valid — default: never auto-reverse on inference regardless). If Privy can't express aggregate/per-recipient policy, implement it in the **independent co-signer service** and run `QUORUM_THRESHOLD=0`.
- **Phase 1 — Deposit** (money-in, lower risk): seam + migration + deposit flow + confirmer + reconciliation read side. Internal wallet only.
- **Phase 2 — Withdraw** (money-out): withdraw state machine + quorum/Intents + kill-switch + admin tooling. Tiny caps, `QUORUM_THRESHOLD=0`, internal wallet first, reconciliation alerting **live before any external user**.

### 14a. Phase 0 static-findings results (2026-06-23) — STATIC HALF DONE

Phase 0's **static half** is complete: every assumed capability was verified against the installed `@privy-io/node@0.22.0` types. Full doc: `docs/superpowers/specs/2026-06-23-phase0-privy-capability-findings.md`. Net: the custody core is statically sound, but **three findings change the design**:

1. **(HARD, §9) Native rolling-window aggregate-spend cap is ABSENT for Solana.** Privy's `Aggregations` resource is an empty class and `AggregationMethod` is Ethereum-only. The §9 "native aggregate cap" is unmet → the 24h velocity/aggregate ceiling **must live in our own co-signer/quorum member** (server tracks cumulative spend, refuses to co-sign past the window). Per-tx amount / USDC-mint / SPL-program / recipient allowlist (constraints 1–4) **are** native Privy policy rules and stay there.
2. **(HARD, §6.3/§9) No native `intents.authorize()`/`execute()` SDK method.** Intents supports create+poll only; the out-of-band approver **must POST its own P-256 request signature** (via `lib/authorization.ts`) to the intent's authorize route (route shape confirmed in staging item 9). Quorum-owned wallet + pending-intent create/poll are real and unchanged.
3. **(SOFT, §5/§14) Treasury-as-fee-payer deposit sponsorship is UNVERIFIED.** No SDK param names the treasury as on-chain fee-payer for a user-authority tx; `sponsor:true` is opaque USD gas-credit billing. **This is the single gating staging test (item 1) and it blocks Plan 2 (deposit), not just withdraw.** If it fails, deposit falls back to user-pays-gas / pre-fund tiny SOL / Privy-chosen sponsor.

**Library decision (confirmed):** Privy is on the **`@solana/kit` (web3.js v2)** stack. Add `@solana/kit` + `@solana-program/token` to `server/package.json`, **pin kit to one `^5.x`** shared by Privy + the SPL client (npm `overrides`/`dedupe`, exactly one copy). Do NOT add web3.js v1 / `@solana/spl-token`.

**Empirical half still GATES Plan 2/3** — needs a live Privy staging app + credentials. The 12-item staging checklist is in the findings doc; **item 1 (fee-payer) is the top gate**. Statically-safe foundation work (kit libs + USDC base-unit scale module + idempotency-key util + exact-message model + policy rules 1–4 design) can proceed **now** without staging.

---

## 15. Decisions (defaults adopted 2026-06-23; revisitable before the relevant phase)

1. **Anti-rinse policy (§10): DECIDED** — a short deposit **hold** (funds withdrawable only after N hours, `WITHDRAW_HOLD_HOURS`) **and** a minimal **play-through** requirement, plus an **OFAC screen** of the bound wallet. Full KYC **deferred** until caps lift, but the threshold/posture is documented now. (This is the load-bearing product+legal call; flagged as revisitable if the user wants freer cash-out.)
2. **ATA-creation rent (§9): DECIDED** — **treasury-sponsored** at tiny caps + cumulative-rent alert; revisit (shift to user-borne) at scale if griefed.
3. **Independent approver infra (§6/§9): OPEN — resolve before Phase 2.** Where the off-host quorum/approver key lives (separate service / KMS / second cloud). Needs a named owner; does not block Phase 0/1.
4. **Two-RPC providers (§5/§8): OPEN — resolve before Phase 1 confirmer.** Pick two independent mainnet RPCs (Helius / Triton / QuickNode).

---

## 16. Testing strategy

- **Unit:** asset isolation (no cross-asset bleed, per-asset idempotency, `debitOn` boolean), cap validators inside the reserve tx, BigInt scale (1¢→10_000n, $1→1_000_000n, $5→5_000_000n, dust throws), the full withdrawal state machine (`reserved→signing→sent→confirmed`; `reserved→fail→reverse`; **never** double-reverse, **never** reverse-after-confirm, **never** auto-reverse on inference), deposit exact-message-equality + parsed-delta credit rejecting mismatched amount/dest/mint/program, set-once wallet binding.
- **Integration:** against a local `solana-test-validator` (real SPL mechanics, zero spend) with a stand-in treasury keypair; Privy signing mocked; the real Privy path proven in Phase 0 staging.
- **Adversarial:** double-submit deposit → one credit; replay withdrawal → blocked (boolean reserve); concurrent withdrawals race the cap → single-in-flight index + locks hold; tampered destination → rejected; client submits a different tx than prepared → rejected (message equality); Token-2022 look-alike mint → rejected; injected reconciliation drift → kill-switch trips; unsolicited treasury transfer → not counted as backing.
- **Concurrency:** simultaneous `coin`-stake + `cash`-withdraw on one user (lock-scope proof); multi-replica confirmer (lease + SKIP LOCKED, no double-send).
- **Invariant/property:** `O ≥ L` holds across randomized op sequences incl. crash points.

---

## 17. Reuse map (don't rebuild)

- Ledger primitives, idempotency `(reason,ref)` pattern, per-user advisory lock → extend with `asset`.
- The **guarded one-shot transition** idiom already in `rounds.ts` (`UPDATE … WHERE status='open' RETURNING` + idempotent replay) → the template for both state machines.
- `inventory.grant` boolean idiom → the `debitOn` returning-boolean change.
- `users.walletPublicKey` capture → harden to set-once + `deposit_sources` binding.
- Existing drizzle migration pipeline (`server/drizzle/`, `src/migrate.ts`).
