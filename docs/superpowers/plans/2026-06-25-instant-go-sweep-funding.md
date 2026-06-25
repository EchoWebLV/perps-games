# Instant GO via Sweep-to-Ledger Funding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pressing **GO!** instant by funding an off-chain play balance once (a whole-wallet "sweep") and turning every round into a pure ledger debit — deleting the per-round on-chain play-payment rail entirely.

**Architecture:** Funding moves the player's full Privy-wallet USDC into the `cash` ledger via the already-proven deposit rail (`/v1/deposit/build` → Privy signs once → watch-and-credit). GO then checks the in-game ledger balance and opens the round with zero on-chain work. The `/v1/play/payment/*` rail (8 routes + 3 services) is removed. Privy stays only at the edges (auth, sweep-sign, withdrawals).

**Tech Stack:** TypeScript, Vite client (`redline3d/`), Fastify + Drizzle server (`server/`), `@solana/kit`, Privy, Vitest, PGlite.

**Spec:** `docs/superpowers/specs/2026-06-25-instant-go-sweep-funding-design.md`

**Branch:** Runs on `real-money-rails` (current working tree — no worktree; tree already holds the money-rails WIP). Commit per task.

**Phasing:**
- **Phase 1 (client):** new `play-funding` unit + wallet "Add to play balance" + GO becomes a pure ledger debit + stop calling the play-payment rail. **This delivers instant GO.**
- **Phase 2 (server):** delete the `/v1/play/payment/*` rail and its services. **Pure removal; do AFTER Phase 1 so the client never calls a deleted route.**
- **Phase 3 (server, OPTIONAL, money-safety-careful):** lower the sweep credit from `finalized` (~13s) to `confirmed` (~1–2s) with finality reconciliation. Separable — Phases 1–2 already make GO instant; funding just confirms in ~13s (once per session, off the hot path) until Phase 3 lands.

---

## File Structure

**Phase 1 — client (`redline3d/`):**
- **Create** `src/core/play-funding.ts` — pure, DOM-free sweep unit (build → sign → poll-credit). Owns `InsufficientWalletBalanceError` + `SweepConfirmTimeoutError`.
- **Create** `src/core/play-funding.test.ts` — unit tests (fakes, no network/DOM).
- **Modify** `src/ui/wallet.ts` — add an "Add to play balance" CTA + `onAddToPlay` callback + busy/error states.
- **Modify** `src/main.ts` — rip the per-round charge block out of `onLaunch`; wire `walletUI` add-to-play to `sweepToPlayBalance`; drop play-payment imports/state.
- **Modify** `src/core/api.ts` — remove `playPayment*` methods + their types; keep `depositBuild`, `walletBalance`, `me`.
- **Delete** `src/core/play-payment.ts` + `src/core/play-payment.test.ts`.

**Phase 2 — server (`server/`):**
- **Delete** `src/services/play-payments.ts`, `src/services/play-payment-charger.ts`, `src/services/play-payment-broadcaster.ts`, `src/services/play-payments.test.ts`, `src/services/play-payment-charger.test.ts`.
- **Modify** `src/http/routes.ts`, `src/index.ts`, `src/env.ts`, `src/test/harness.ts`, `src/test/deposit-address.test.ts`, `src/test/env.real-money.test.ts`.

**Phase 3 — server (optional):** `src/solana/deposit-source.ts`, `src/services/deposits.ts`, `src/services/deposit-worker.ts`, `src/services/ledger.ts`, `src/db/schema.ts` + a new migration.

---

# PHASE 1 — Client: instant GO + sweep funding

### Task 1: `play-funding` core unit (TDD)

**Files:**
- Create: `redline3d/src/core/play-funding.ts`
- Test: `redline3d/src/core/play-funding.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// redline3d/src/core/play-funding.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  sweepToPlayBalance,
  InsufficientWalletBalanceError,
  SweepConfirmTimeoutError,
} from "./play-funding";

describe("sweepToPlayBalance", () => {
  it("sweeps the whole wallet balance and resolves once the server credits it", async () => {
    const buildDepositTx = vi.fn(async () => "txb64");
    const signAndSend = vi.fn(async () => "sig123");
    const pollServerBalance = vi.fn()
      .mockResolvedValueOnce(0)    // not credited yet
      .mockResolvedValueOnce(500); // credited

    const newBalance = await sweepToPlayBalance({
      walletBalanceCents: 500,
      startingServerBalance: 0,
      buildDepositTx,
      signAndSend,
      pollServerBalance,
      delay: async () => {},
      pollMs: 1,
    });

    expect(buildDepositTx).toHaveBeenCalledWith(500); // the FULL wallet balance
    expect(signAndSend).toHaveBeenCalledWith("txb64");
    expect(newBalance).toBe(500);
  });

  it("adds the swept amount on top of an existing in-game balance", async () => {
    const newBalance = await sweepToPlayBalance({
      walletBalanceCents: 300,
      startingServerBalance: 200,
      buildDepositTx: async () => "tx",
      signAndSend: async () => "sig",
      pollServerBalance: async () => 500, // 200 existing + 300 swept
      delay: async () => {},
    });
    expect(newBalance).toBe(500);
  });

  it("rejects before building a tx when the wallet has nothing to sweep", async () => {
    const buildDepositTx = vi.fn(async () => "tx");
    await expect(sweepToPlayBalance({
      walletBalanceCents: 0,
      startingServerBalance: 0,
      buildDepositTx,
      signAndSend: async () => "sig",
      pollServerBalance: async () => 0,
      delay: async () => {},
    })).rejects.toBeInstanceOf(InsufficientWalletBalanceError);
    expect(buildDepositTx).not.toHaveBeenCalled();
  });

  it("throws SweepConfirmTimeoutError when the credit never arrives in maxPolls", async () => {
    await expect(sweepToPlayBalance({
      walletBalanceCents: 100,
      startingServerBalance: 0,
      buildDepositTx: async () => "tx",
      signAndSend: async () => "sig",
      pollServerBalance: async () => 0, // never credited
      delay: async () => {},
      maxPolls: 3,
      pollMs: 1,
    })).rejects.toBeInstanceOf(SweepConfirmTimeoutError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd redline3d && npx vitest run src/core/play-funding.test.ts`
Expected: FAIL — `Cannot find module './play-funding'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// redline3d/src/core/play-funding.ts

/** The wallet (plus any in-game balance) cannot fund the requested action. */
export class InsufficientWalletBalanceError extends Error {
  constructor() {
    super("insufficient_wallet_balance");
    this.name = "InsufficientWalletBalanceError";
  }
}

/** The sweep was sent but the server had not credited it within the poll window. */
export class SweepConfirmTimeoutError extends Error {
  constructor() {
    super("sweep_confirm_timeout");
    this.name = "SweepConfirmTimeoutError";
  }
}

export interface SweepToPlayBalanceOpts {
  /** on-chain USDC in the Privy wallet right now, in cents */
  walletBalanceCents: number;
  /** in-game ledger balance before the sweep, in cents */
  startingServerBalance: number;
  /** build the unsigned wallet→treasury deposit tx for `amountCents`; resolves to base64 */
  buildDepositTx: (amountCents: number) => Promise<string>;
  /** sign + broadcast the tx via Privy; resolves to the tx signature */
  signAndSend: (txBase64: string) => Promise<string>;
  /** read the current in-game ledger balance (cents) */
  pollServerBalance: () => Promise<number>;
  /** smallest sweepable amount; below this there is nothing worth a tx (default 1c) */
  minSweepCents?: number;
  maxPolls?: number;
  pollMs?: number;
  delay?: (ms: number) => Promise<void>;
}

/**
 * Move the player's ENTIRE Privy-wallet USDC into the off-chain play balance, once.
 * On-chain happens here (one tx); afterwards every round is an instant ledger debit.
 * Resolves to the new in-game balance.
 */
export async function sweepToPlayBalance(opts: SweepToPlayBalanceOpts): Promise<number> {
  const amount = opts.walletBalanceCents;
  if (amount < (opts.minSweepCents ?? 1)) throw new InsufficientWalletBalanceError();

  const txBase64 = await opts.buildDepositTx(amount);
  await opts.signAndSend(txBase64);

  const target = opts.startingServerBalance + amount;
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPolls = opts.maxPolls ?? 30;
  const pollMs = opts.pollMs ?? 1000;
  for (let i = 0; i < maxPolls; i++) {
    const balance = await opts.pollServerBalance();
    if (balance >= target) return balance;
    await delay(pollMs);
  }
  throw new SweepConfirmTimeoutError();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd redline3d && npx vitest run src/core/play-funding.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/play-funding.ts redline3d/src/core/play-funding.test.ts
git commit -m "feat(funding): add sweepToPlayBalance — whole-wallet → play balance, one tx"
```

---

### Task 2: Wallet "Add to play balance" CTA

**Files:**
- Modify: `redline3d/src/ui/wallet.ts` (interface `WalletOpts` ~20-33; Buy view markup ~172-176; handlers ~218-225)

- [ ] **Step 1: Add the `onAddToPlay` + `onAddError` callbacks to `WalletOpts`**

In `WalletOpts` (after `onWalletPoll?`), add:

```ts
  /** Sweep the whole Privy-wallet USDC into the in-game play balance. Resolves when credited. */
  onAddToPlay?: () => Promise<void>;
```

- [ ] **Step 2: Add the CTA to the Buy view markup**

Replace the Buy view block (currently lines ~172-176):

```ts
    `<div class="wlt-view" data-view="buy">
       <div class="wlt-amts">${AMOUNTS.map((a) => `<button class="wlt-amt" data-amt="${a}">$${a}<small>USDC</small></button>`).join("")}</div>
       <button class="wlt-cta" id="wltBuy">Buy USDC</button>
       <div class="wlt-note">Use Receive to add USDC to your Privy wallet.</div>
     </div>` +
```

with (adds a primary "Add to play balance" button + a status line; keeps the Buy placeholder below):

```ts
    `<div class="wlt-view" data-view="buy">
       <button class="wlt-cta ok" id="wltAddPlay">Add to play balance</button>
       <div class="wlt-note" id="wltAddNote">Move your wallet USDC into your play balance — then GO is instant.</div>
       <div class="wlt-amts">${AMOUNTS.map((a) => `<button class="wlt-amt" data-amt="${a}">$${a}<small>USDC</small></button>`).join("")}</div>
       <button class="wlt-cta" id="wltBuy">Buy USDC</button>
       <div class="wlt-note">Use Receive to add USDC to your Privy wallet.</div>
     </div>` +
```

- [ ] **Step 3: Wire the handler**

After the `buyBtn.onclick` block (~line 225), add:

```ts
  const addPlayBtn = q<HTMLButtonElement>("#wltAddPlay");
  const addNote = q<HTMLElement>("#wltAddNote");
  let adding = false;
  addPlayBtn.onclick = async () => {
    if (adding || !opts.onAddToPlay) return;
    adding = true;
    addPlayBtn.disabled = true;
    const original = addPlayBtn.textContent;
    addPlayBtn.textContent = "Adding…";
    addNote.textContent = "Funds on the way — they'll appear shortly.";
    try {
      await opts.onAddToPlay();
      renderBalance(true);
      addPlayBtn.textContent = "✓ Added to play balance";
      addNote.textContent = "Ready — press GO to race.";
    } catch {
      addPlayBtn.textContent = original ?? "Add to play balance";
      addNote.textContent = "Couldn't add funds. Make sure your wallet holds USDC, then try again.";
    } finally {
      adding = false;
      addPlayBtn.disabled = false;
      window.setTimeout(() => { if (!adding) addPlayBtn.textContent = "Add to play balance"; }, 2000);
    }
  };
```

- [ ] **Step 4: Type-check**

Run: `cd redline3d && npx tsc --noEmit`
Expected: PASS (no errors from `wallet.ts`). `onAddToPlay` is optional, so existing callers still compile.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/ui/wallet.ts
git commit -m "feat(wallet): add 'Add to play balance' sweep CTA"
```

---

### Task 3: Rewire `main.ts` — GO is a pure ledger debit

**Files:**
- Modify: `redline3d/src/main.ts` — imports (23-31), `createWallet` opts (~224-238), `onLaunch` (479-642), and the `paymentInFlight` state.

- [ ] **Step 1: Replace the play-payment import block**

Replace lines 23-31:

```ts
import {
  ensurePlayPayment,
  InsufficientWalletBalanceError,
  isServerPlayPaymentChargePreSendFailure,
  isServerPlayPaymentChargeUnavailable,
  PlayPaymentConfirmationError,
} from "./core/play-payment";
import { settleWithTimeout } from "./core/signing-timeout";
import { displayCashBalance, payoutWalletBalanceFloor } from "./core/wallet-balance-model";
```

with:

```ts
import { sweepToPlayBalance, InsufficientWalletBalanceError, SweepConfirmTimeoutError } from "./core/play-funding";
import { displayCashBalance, payoutWalletBalanceFloor } from "./core/wallet-balance-model";
```

(`settleWithTimeout` was used only by the deleted client-sign fallback — Step 5 verifies it has no other use.)

- [ ] **Step 2: Wire the wallet's `onAddToPlay` to the sweep**

In the `createWallet(hudRoot, { ... })` options object (~line 224), add an `onAddToPlay` handler. Place it alongside the existing `onWalletPoll`/`onBuy` options:

```ts
  onAddToPlay: async () => {
    const walletCents = walletBalance ?? 0;
    serverBalance = await sweepToPlayBalance({
      walletBalanceCents: walletCents,
      startingServerBalance: serverBalance,
      buildDepositTx: async (amountCents) => (await api.depositBuild(amountCents)).txBase64,
      signAndSend: (txBase64) => auth.signAndSendTransaction!(txBase64),
      pollServerBalance: async () => {
        const me = await api.me();
        serverBalance = me.balance;
        try { await refreshWalletBalance(); } catch { /* keep last wallet read */ }
        syncDisplayedBalance(); walletUI.setBalance(balance);
        return serverBalance;
      },
    });
    syncDisplayedBalance(); walletUI.setBalance(balance);
  },
```

- [ ] **Step 3: Replace the `onLaunch` payment block with a pure balance check**

Replace lines 502-616 (everything from `const playAmount = controls.playAmount();` through the `if (!auth.walletPublicKey?.() && serverBalance < playAmount) { ... }` line) with:

```ts
  const playAmount = controls.playAmount();
  if (serverBalance < playAmount) {
    // No on-chain at GO time. Send the player to the wallet to top up their play balance.
    controls.setLive(false, "GO!");
    hud.setStatus("Add USDC to your play balance to race.");
    walletUI.open();
    return;
  }
```

Then remove the now-unused `paymentInFlight` from the re-entrancy guard at line 484 — change:

```ts
  if (paymentInFlight || settling || roundSync.isOpening() || engine.getPhase() === "live") return; // re-entrancy: don't race an in-flight settle/payment
```

to:

```ts
  if (settling || roundSync.isOpening() || engine.getPhase() === "live") return; // re-entrancy: don't race an in-flight settle
```

- [ ] **Step 4: Remove the `paymentInFlight` declaration**

Run: `cd redline3d && grep -n "paymentInFlight\|paymentAttemptId\|playSignerReadyWallet" src/main.ts`
Delete the `let paymentInFlight = ...` declaration and any other now-orphaned payment-state lines it reports (e.g. `paymentAttemptId`, `playSignerReadyWallet`) that were only used by the deleted block. (tsc in Step 5 catches any miss.)

- [ ] **Step 5: Type-check the client**

Run: `cd redline3d && npx tsc --noEmit`
Expected: PASS. If `settleWithTimeout`, `payoutWalletBalanceFloor`, or any helper is now unused, tsc/eslint will flag it — remove the dead import/usage. Fix until clean.

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/main.ts
git commit -m "feat(play): GO is a pure ledger debit; sweep funds from the wallet page"
```

---

### Task 4: Trim `play-payment*` from the client API

**Files:**
- Modify: `redline3d/src/core/api.ts` — types (13-53), `Api` interface (82-97), impl (147-157)

- [ ] **Step 1: Remove the play-payment types**

Delete the interfaces/types `PlayPaymentConfirmResult` (13-24), `PlayPaymentSendResult` (25), `PlayPaymentChargeResult` (26), `PlayPaymentAuthorizationRequest` (27-41), `PlayPaymentPrepareResult` (42-46), `PlayPaymentSigner` (47-50), `PlayPaymentSignerResult` (51-53). Keep `WalletBalanceResult` (12).

- [ ] **Step 2: Remove the play-payment methods from the `Api` interface**

Delete lines 82-97 (the JSDoc + signatures for `playPaymentBuild`, `playPaymentSend`, `playPaymentCharge`, `playPaymentSigner`, `playPaymentPrepare`, `playPaymentChargeAuthorized`, `playPaymentConfirm`, `playPaymentRecover`). Keep `depositBuild` (80-81) and `walletBalance` (98-99).

- [ ] **Step 3: Remove the play-payment method impls**

Delete lines 147-157 (the `playPayment*` entries in the returned object). Keep `depositBuild` (146) and `walletBalance` (158).

- [ ] **Step 4: Type-check**

Run: `cd redline3d && npx tsc --noEmit`
Expected: PASS — `main.ts` no longer references any `playPayment*` member (removed in Task 3).

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/api.ts
git commit -m "refactor(api): drop the play-payment client methods (rail removed)"
```

---

### Task 5: Delete `play-payment.ts` + verify Phase 1

**Files:**
- Delete: `redline3d/src/core/play-payment.ts`, `redline3d/src/core/play-payment.test.ts`

- [ ] **Step 1: Delete the files**

```bash
git rm redline3d/src/core/play-payment.ts redline3d/src/core/play-payment.test.ts
```

- [ ] **Step 2: Verify nothing still imports them**

Run: `cd redline3d && grep -rn "play-payment\|ensurePlayPayment\|isServerPlayPaymentCharge\|PlayPaymentConfirmationError" src`
Expected: NO matches (all moved/removed).

- [ ] **Step 3: Full client gate**

Run: `cd redline3d && npx tsc --noEmit && npx vitest run && npx vite build`
Expected: tsc clean, all tests PASS, build OK. Fix any fallout (e.g. a stale test referencing the old module) until green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(play): remove the client per-round play-payment unit"
```

---

# PHASE 2 — Server: delete the play-payment rail

> Order matters: do this AFTER Phase 1 so the client never calls a route that no longer exists. Every step ends green (`npx tsc --noEmit` + `npx vitest run` in `server/`).

### Task 6: Relocate the shared deposit-bounds constants

`PLAY_PAYMENT_MIN_CENTS=1` / `PLAY_PAYMENT_MAX_CENTS=5000` live in `services/play-payments.ts` (to be deleted) but are used in `index.ts:53` for deposit bounds.

**Files:** Modify `server/src/index.ts:53`

- [ ] **Step 1: Rewrite the deposit-bounds line to not depend on the play constants**

At `index.ts:53`, replace:

```ts
    minCents: PLAY_PAYMENT_MIN_CENTS, maxCents: Math.max(env.DEPOSIT_MAX_CENTS, PLAY_PAYMENT_MAX_CENTS),
```

with:

```ts
    minCents: env.DEPOSIT_MIN_CENTS, maxCents: env.DEPOSIT_MAX_CENTS,
```

- [ ] **Step 2: Remove the now-unused import** at `index.ts:12`:

```ts
import { PLAY_PAYMENT_MAX_CENTS, PLAY_PAYMENT_MIN_CENTS, type PlayPaymentConfirmResult } from "../services/play-payments.js";
```

(Delete the whole line — `PlayPaymentConfirmResult` is referenced only by play-payment wiring removed in Task 8.)

- [ ] **Step 3: Type-check** (will still error until Tasks 7-8 — that's expected). Run `cd server && npx tsc --noEmit` and note the remaining errors are only in the play-payment wiring you delete next.

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "refactor(deposit): bound deposits by DEPOSIT_* env, not play constants"
```

> If `DEPOSIT_MIN_CENTS` floor differs from the old `1`, confirm the deposit min in `env.ts` is the intended floor (it is the deposit-specific bound; the old `1` came from play). Keep the deposit semantics.

### Task 7: Remove the play-payment routes from `routes.ts`

**Files:** Modify `server/src/http/routes.ts`

- [ ] **Step 1: Remove the route handlers and play-only helpers/schemas.** Delete exactly:
  - import line **10** (`PLAY_PAYMENT_*` / `PlayPaymentConfirmResult` from `play-payments.js`)
  - `RouteDeps` fields **27-29** (`playPaymentBroadcaster`, `playPaymentCharger`, `playPaymentConfirmer`)
  - helpers **61-97** (`playPaymentRefundRef` + `refundExcessPlayPayment`) and **190-213** (`mapPlayPaymentChargeError`)
  - play-only zod consts **140-154** (`PlayPaymentSendBody` … `PlayPaymentRecoverBody`) — **keep `DepositBuildBody` at line 139**
  - the `/v1/play/payment/build` call site **177-181**
  - routes **183-188** (`/send`), **215-326** (`/signer`, `/prepare`, `/charge-authorized`, `/charge`, `/confirm`, `/recover`)
  - **Keep** `buildUserToVaultTx` (155-172) and `/v1/deposit/build` (173-175).

- [ ] **Step 2: Verify no play-payment route literals remain**

Run: `cd server && grep -n "play/payment\|PlayPayment\|playPayment\|refundExcessPlayPayment\|mapPlayPaymentChargeError" src/http/routes.ts`
Expected: NO matches.

- [ ] **Step 3: Commit** (tsc still red until Task 8 — fine):

```bash
git add server/src/http/routes.ts
git commit -m "refactor(routes): remove /v1/play/payment/* routes"
```

### Task 8: Remove the play-payment wiring from `index.ts` + `harness.ts`

**Files:** Modify `server/src/index.ts`, `server/src/test/harness.ts`

- [ ] **Step 1: `index.ts` — delete play-payment construction/injection.** Remove:
  - decls **35-37** (`let playPaymentBroadcaster/Charger/Confirmer = null`)
  - dynamic imports **46-47** (`makeRpcPlayPaymentBroadcaster`, `makePlayPaymentConfirmer`)
  - construction **59-60** (`playPaymentConfirmer = …`, `playPaymentBroadcaster = …`)
  - the play-charger block **96-116** (the `if (privyClient) { const { makePlayPaymentCharger } … } else { console.warn("[play_payment_charger_disabled]…") }`). **Keep** `privyClient` (63-67) and `depositTxBuilder` (89-95) — shared with deposit/withdraw/payout.
  - injection keys **161-163** (`playPaymentBroadcaster,` `playPaymentCharger,` `playPaymentConfirmer,`)

- [ ] **Step 2: `test/harness.ts` — drop the three play deps.** Remove the play-payment keys from the `makeTestDb` opts type (line 24) and the deps pass-through (lines 48-50).

- [ ] **Step 3: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: PASS (the rail is fully unwired now).

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts server/src/test/harness.ts
git commit -m "refactor(server): unwire the play-payment charger/broadcaster/confirmer"
```

### Task 9: Remove play-only env vars

**Files:** Modify `server/src/env.ts`, `server/src/test/env.real-money.test.ts`

- [ ] **Step 1: `env.ts` — remove play-only vars + their refine.** Delete `PRIVY_PLAY_SIGNER_ID` (17), `PRIVY_PLAY_SIGNER_PRIVATE_KEY` (18), `PRIVY_PLAY_SIGNER_POLICY_IDS` (19), and the cross-field refine block (51-57, the `"…must be set together"` check). Keep all `PRIVY_APP_*`, `TREASURY_*`, `SOLANA_*`, `USDC_MINT`, `DEPOSIT_*`, `WITHDRAW_*`.

- [ ] **Step 2: Fix the env test.** Run `cd server && grep -n "PRIVY_PLAY_SIGNER" src/test/env.real-money.test.ts` and remove/adjust any case asserting the deleted vars or the pairing refine.

- [ ] **Step 3: Type-check + test the env module**

Run: `cd server && npx tsc --noEmit && npx vitest run src/test/env.real-money.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/env.ts server/src/test/env.real-money.test.ts
git commit -m "chore(env): drop play-payment signer env vars"
```

### Task 10: Prune the mixed deposit-address test

**Files:** Modify `server/src/test/deposit-address.test.ts`

- [ ] **Step 1: Delete the play-payment `describe` blocks**, keeping the deposit ones above. Remove:
  - `describe("POST /v1/play/payment/build")` **67-118**
  - `describe("POST /v1/play/payment/confirm")` **120-195**
  - `describe("POST /v1/play/payment/recover")` **197-282**
  - `describe("POST /v1/play/payment/charge")` **284-~505** (covers `/signer`, `/prepare`, `/charge-authorized`)
  - `describe("POST /v1/play/payment/send")` **507-end**
  - Keep everything for `/v1/deposit/address` and `/v1/deposit/build` (above line 67).

- [ ] **Step 2: Verify + run**

Run: `cd server && grep -n "play/payment\|playPayment" src/test/deposit-address.test.ts` → NO matches.
Run: `cd server && npx vitest run src/test/deposit-address.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/test/deposit-address.test.ts
git commit -m "test(deposit): drop play-payment cases from deposit-address tests"
```

### Task 11: Delete the play-payment service files + full server gate

**Files:** Delete `server/src/services/play-payments.ts`, `play-payment-charger.ts`, `play-payment-broadcaster.ts`, `play-payments.test.ts`, `play-payment-charger.test.ts`

- [ ] **Step 1: Delete**

```bash
git rm server/src/services/play-payments.ts server/src/services/play-payment-charger.ts \
       server/src/services/play-payment-broadcaster.ts \
       server/src/services/play-payments.test.ts server/src/services/play-payment-charger.test.ts
```

- [ ] **Step 2: Verify nothing imports them**

Run: `cd server && grep -rn "play-payment\|PlayPayment\|makePlayPaymentConfirmer\|makePlayPaymentCharger\|makeRpcPlayPaymentBroadcaster" src`
Expected: NO matches.

- [ ] **Step 3: Full server gate**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: tsc clean, full suite PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(server): remove play-payment services and tests"
```

---

# PHASE 3 — OPTIONAL: lower the sweep credit to `confirmed` (~1–2s)

> **Money-safety-careful. Independent of the instant-GO win above.** Phases 1–2 already make GO instant; this only shrinks the one-time funding confirmation from `finalized` (~13s) to `confirmed` (~1–2s). It touches the shared deposit poller and adds a finality-reconciliation net (the codebase has none for deposits). **Recommendation:** ship Phases 1–2, then do this deliberately — consider giving it its own brainstorm/spec. Tasks below are concrete if you proceed now.

**Mechanism today (verified):** the deposit poller (`deposit-worker.ts`) reads inbound transfers via `deposit-source.ts` at `commitment: "finalized"` (lines 90, 101, 121) and stamps `finalized: true` (line 66); `deposits.recordInbound` quarantines `!t.finalized` (line 42). There is exactly one `DepositSource`/poller for all inbound USDC, and **no reversal path for a credited deposit** (the template to copy is `withdraw-worker.ts` `makeWithdrawConfirmer`, which reverses via `ledger.creditOn(..., "withdraw_reverse", id)` and a `reversed`/`needs_review` status).

### Task 12: Thread a `commitment` param through the deposit source (TDD)
- Add an optional `commitment: "confirmed" | "finalized"` to `fetchInbound`/`fetchTransfer` in `deposit-source.ts`; default `"finalized"`. Stamp `InboundTransfer.finalized` truthfully (`commitment === "finalized"`), or add a distinct `commitment` field. Keep `readTreasuryBaseUnits` (withdraw solvency) at `finalized`. Test: a fake RPC asserts the commitment passed through.

### Task 13: Credit at `confirmed`, mark pending-finality (TDD)
- In `deposits.recordInbound`, allow crediting a `confirmed` (not-yet-finalized) transfer for a bound self-deposit, recording the deposit row with a `pending_final` marker instead of quarantining at line 42. Pass `commitment: "confirmed"` from the confirmer's `tick` (`deposit-worker.ts`). Tests cover: confirmed self-deposit credits; still quarantines wrong-dest/mint/program/bounds/unknown-source.

### Task 14: Add the `deposit_reverse` ledger reason + schema (TDD + migration)
- Add `deposit_reverse` to `ledger.ts` `CASH_REASONS` (line 7) and the `ledger_cash_ref_chk` check constraint (`schema.ts` 60-62); extend `depositStatus` enum (`schema.ts` 69) with `pending_final` + `reversed`/`needs_review`. Write a Drizzle migration. Test idempotency on `(asset, reason, ref)`.

### Task 15: Finality-reconciliation pass (TDD)
- Mirror `makeWithdrawConfirmer`: a pass that re-reads `pending_final` deposits at `finalized`; on rooted → mark `credited`/final; on a confirmed tx that never roots past its blockhash window → reverse via `ledger.creditOn(tx, userId, "cash", -cents, "deposit_reverse", txSig)` + status `reversed` (or `needs_review` if ambiguous — prefer detect-over-auto-reverse, matching the withdraw `never-auto-reverse` posture). Wire it into the worker loop. Tests: rooted→final, never-roots→reversed, ambiguous→needs_review. Then `reconcile`/solvency stays green.

---

# Final verification (after Phase 1–2, and again after Phase 3 if done)

- [ ] `cd server && npx tsc --noEmit && npx vitest run` — green.
- [ ] `cd redline3d && npx tsc --noEmit && npx vitest run && npx vite build` — green.
- [ ] **Browser verify (REQUIRED — tsc/tests passing ≠ it works; see `verify-ui-in-browser-before-done`).** Boot server + client locally, load redline3d in Claude Preview:
  - Press GO with an empty play balance → status "Add USDC to your play balance to race" + the wallet opens (no on-chain wait, no charge attempt in the network log).
  - With a funded play balance (dev grant or a real/sim credit) → GO opens a round **immediately** with no `/v1/play/payment/*` call and no on-chain confirmation wait.
  - "Add to play balance" sweeps the wallet → balance moves into the play balance → subsequent GOs are instant.
- [ ] Confirm the network panel shows **no** `/v1/play/payment/*` requests anywhere in the GO flow.

---

## Self-Review (completed by author)

- **Spec coverage:** Funding-sweep ✔ (Task 1-3), GO pure-debit ✔ (Task 3), delete play-payment rail ✔ (Task 4-5 client, 6-11 server), withdraw unchanged ✔ (untouched), Privy at edges ✔ (sweep-sign only), `confirmed` funding ✔ (Phase 3). Out-of-scope items (drop-Privy, on-chain, anchor proofs, WebSocket confirm, auto-sweep, partial sweep) intentionally absent.
- **Placeholder scan:** none — deletions cite exact line ranges from a read-only code map; new code is shown in full.
- **Type consistency:** `sweepToPlayBalance`/`InsufficientWalletBalanceError`/`SweepConfirmTimeoutError` defined in Task 1 and consumed in Task 2-3; `onAddToPlay` optional in `WalletOpts` (Task 2) and supplied in `main.ts` (Task 3); `api.depositBuild`/`api.me`/`auth.signAndSendTransaction` already exist (verified). `paymentInFlight`/`settleWithTimeout` removals guarded by `tsc`.
- **Risk note:** Phase 1-2 are reversible (git) and protected by tsc + full suites + browser verify. The one money-safety knob (`confirmed` crediting) is isolated in Phase 3 with the reversal net spelled out.
