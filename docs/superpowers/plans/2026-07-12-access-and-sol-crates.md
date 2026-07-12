# Access Recovery and Devnet SOL Crates Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep access-code redemption permanently reachable and let signed-in players buy Silver and Gold crates with confirmed devnet SOL transfers.

**Architecture:** The existing access wall remains the mandatory first-run gate, while a new dismissible instance is exposed from the game menu for repeat redemptions. Paid crate purchases use a small Solana transfer adapter, wait for devnet confirmation, and only then request the existing MagicBlock VRF draw. A paid draw is retained in memory when VRF fails so a retry cannot charge twice during the same session.

**Tech Stack:** TypeScript, Vite, Vitest, jsdom, `@solana/web3.js`, Privy embedded wallets, MagicBlock VRF, Capacitor Android, Railway.

---

### Task 1: Restore permanent access-code entry

**Files:**
- Modify: `redline3d/src/ui/access-wall.ts`
- Modify: `redline3d/src/ui/access-wall.test.ts`
- Modify: `redline3d/src/ui/carpicker.ts`
- Modify: `redline3d/src/ui/carpicker.test.ts`
- Modify: `redline3d/src/main.ts`

**Steps:**
1. Add failing tests proving the access wall can optionally be dismissed and the hamburger menu invokes an access-code callback.
2. Run the focused tests and confirm they fail for the missing behavior.
3. Add an optional dismiss control to `createAccessWall`; omit it for the mandatory boot gate.
4. Add a `Redeem access code` menu row and callback to `MenuFeatures`.
5. Wire the callback in `main.ts` to the existing guest or account redemption ports without reloading the game.
6. Run focused tests and confirm they pass.

### Task 2: Replace card prices with devnet SOL prices

**Files:**
- Modify: `redline3d/src/core/crate.ts`
- Modify: `redline3d/src/core/crate.test.ts`
- Modify: `redline3d/src/ui/cratebox.ts`
- Modify: `redline3d/src/ui/cratebox.test.ts`

**Steps:**
1. Add failing tests for Silver at `0.1 SOL`, Gold at `0.2 SOL`, and no SOL price on Wooden crates.
2. Replace `priceUsd` with `priceSol` in the crate model.
3. Render SOL purchase buttons and remove the placeholder card-payment path.
4. Run focused model and UI tests.

### Task 3: Implement confirmed devnet SOL payment

**Files:**
- Create: `redline3d/src/chain/sol-payment.ts`
- Create: `redline3d/src/chain/sol-payment.test.ts`
- Modify: `redline3d/.env.development`
- Modify: `redline3d/.env.production`

**Steps:**
1. Add failing unit tests for SOL-to-lamports conversion, transfer construction, wallet signing, raw submission, confirmation, and confirmation errors.
2. Implement a payment adapter using `SystemProgram.transfer` and the existing Anchor-compatible wallet.
3. Require a configured public treasury address and use the existing devnet RPC configuration.
4. Add the public treasury address to development and production Vite configuration.
5. Run the focused payment tests.

### Task 4: Couple payment and VRF without double charging

**Files:**
- Modify: `redline3d/src/ui/cratebox.ts`
- Modify: `redline3d/src/ui/cratebox.test.ts`

**Steps:**
1. Add failing tests proving an unsigned guest cannot trigger payment, a confirmed payment proceeds to VRF, and retrying after VRF failure does not pay twice.
2. Add a `buyWithSol` dependency and a SOL opening path that requires authenticated VRF mode before payment.
3. Store a successful payment signature in memory until its crate reveal succeeds.
4. Preserve the pending paid draw on VRF failure and consume it on a same-tier retry.
5. Ensure rejected or unconfirmed payments grant no reward.
6. Run focused crate-box tests.

### Task 5: Wire the wallet payment into the game

**Files:**
- Modify: `redline3d/src/main.ts`
- Modify: relevant source-level integration tests under `redline3d/src/**/*.test.ts`

**Steps:**
1. Add a failing source or integration test for the new payment wiring.
2. Use `session.anchorWallet()` and the configured treasury to call the devnet payment adapter.
3. Surface clear sign-in, wallet rejection, transfer failure, and retry messages.
4. Remove the old card-payment placeholder.
5. Run focused integration tests.

### Task 6: Verify, package, deploy, and commit

**Files:**
- Update generated web and Android build outputs only through existing scripts.

**Steps:**
1. Run the complete frontend test suite and production build.
2. Run native asset preparation and inspect the Android bundle to confirm landing assets remain excluded.
3. Build and install the APK on the connected Seeker.
4. Deploy the web build to the existing Railway web service.
5. Upload the rebuilt APK to the existing public download path.
6. Verify the landing page, `/play/`, APK response, and installed Android launch behavior.
7. Review the diff, commit the major task, and leave unrelated user files untouched.
