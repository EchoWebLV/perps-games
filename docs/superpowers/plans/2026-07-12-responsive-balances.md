# Responsive Balance Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render confirmed crate spending and authoritative race settlements immediately without waiting for additional RPC reads.

**Architecture:** A pure helper applies confirmed wallet deltas in display units. `GameSession` caches the balance returned by every settlement path. `main.ts` renders the sum of current session balance and known wallet balance immediately, then uses RPC only to reconcile.

**Tech Stack:** TypeScript, Vite, Vitest, Solana web3.js, MagicBlock session balances.

## Global Constraints

- Never change display state before a transaction is confirmed.
- RPC failures retain the latest confirmed display.
- Clamp wallet display units at zero.
- Preserve guest practice behavior.

---

### Task 1: Confirmed wallet spend arithmetic

**Files:**
- Modify: `redline3d/src/core/wallet-balance-model.ts`
- Test: `redline3d/src/core/wallet-balance-model.test.ts`

**Interfaces:**
- Produces: `applyConfirmedWalletSpend(knownWalletUnits: number, priceSol: number, displayUnitDecimals: number): number`

- [ ] **Step 1: Write the failing unit tests**

Add expectations that `10 SOL - 0.2 SOL` becomes `980` centi-SOL units and that spending from a stale low balance clamps to `0`.

```ts
expect(applyConfirmedWalletSpend(1_000, 0.2, 2)).toBe(980);
expect(applyConfirmedWalletSpend(5, 0.1, 2)).toBe(0);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/core/wallet-balance-model.test.ts`

Expected: FAIL because `applyConfirmedWalletSpend` is not exported.

- [ ] **Step 3: Implement the pure helper**

Convert the SOL price with `10 ** displayUnitDecimals`, subtract it from the known units, and return `Math.max(0, result)`.

```ts
export function applyConfirmedWalletSpend(knownWalletUnits: number, priceSol: number, displayUnitDecimals: number): number {
  return Math.max(0, knownWalletUnits - Math.round(priceSol * 10 ** displayUnitDecimals));
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npx vitest run src/core/wallet-balance-model.test.ts`

Expected: all wallet balance model tests pass.

### Task 2: Cache authoritative settlement balances

**Files:**
- Modify: `redline3d/src/chain/game-session.ts`
- Test: `redline3d/src/chain/game-session.test.ts`

**Interfaces:**
- Consumes: `SettledRound.balance: bigint`
- Produces: `GameSession.balance()` updated before `onSettled` for lever and flip settlements.

- [ ] **Step 1: Write failing settlement tests**

Extend the terminal lever test and add a settled flip assertion proving `session.balance()` equals the settlement response balance before an RPC refresh.

```ts
expect(session.balance()).toBe(settled.balance);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/chain/game-session.test.ts`

Expected: the cached balance assertions fail.

- [ ] **Step 3: Cache settlement balance**

Assign `bal = res.balance` in the valid settled lever and flip paths before notifying `main.ts`.

```ts
if (res.settled) {
  bal = res.balance;
  liveSnap = null;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/chain/game-session.test.ts`

Expected: all game-session tests pass.

### Task 3: Render confirmed state immediately and reconcile later

**Files:**
- Modify: `redline3d/src/main.ts`
- Test: `redline3d/src/core/sol-payment-main.test.ts`
- Test: `redline3d/src/core/trade-history-main.test.ts`

**Interfaces:**
- Consumes: `applyConfirmedWalletSpend(...)` and the current `session.balance()` cache.
- Produces: one `renderKnownBalance()` function used before asynchronous RPC reconciliation.

- [ ] **Step 1: Add failing source-level integration assertions**

Require the crate payment callback to apply the confirmed spend and render immediately. Require `finalizeSettled` to call `renderKnownBalance()` before `refreshBalance(...)`.

```ts
expect(source).toContain("walletSolUnits = applyConfirmedWalletSpend");
expect(finalize.indexOf("renderKnownBalance();")).toBeLessThan(finalize.indexOf("session.refreshBalance"));
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run src/core/sol-payment-main.test.ts src/core/trade-history-main.test.ts`

Expected: assertions fail because immediate rendering is absent.

- [ ] **Step 3: Refactor and wire immediate rendering**

Create `renderKnownBalance()` so it reads `session.balance()` at call time. Make `syncOnchainBalance()` render immediately, then replace wallet units with an authoritative RPC result and render again. After `payDevnetSol` confirms, apply the exact crate spend and render. At the start of `finalizeSettled`, render the cached authoritative session balance before starting the existing refresh.

```ts
function renderKnownBalance() {
  balance = baseToUnits(session.balance()) + walletSolUnits;
  hud.setBalance(balance);
  walletUI.setBalance(balance);
}

const signature = await payDevnetSol(wallet, CRATE_TREASURY, priceSol);
walletSolUnits = applyConfirmedWalletSpend(walletSolUnits, priceSol, ACTIVE_STAKE_CURRENCY.displayUnitDecimals);
renderKnownBalance();
return signature;
```

- [ ] **Step 4: Run focused tests and full verification**

Run:

```bash
npx vitest run src/core/wallet-balance-model.test.ts src/chain/game-session.test.ts src/core/sol-payment-main.test.ts src/core/trade-history-main.test.ts
npm test -- --run
npm run build
```

Expected: all tests pass and Vite production build succeeds.

- [ ] **Step 5: Commit and deploy**

Commit only the responsive-balance files, deploy `redline-web`, verify the deployment succeeds, and confirm the served play bundle changed.
