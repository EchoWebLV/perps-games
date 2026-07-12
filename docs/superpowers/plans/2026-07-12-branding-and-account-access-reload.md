# Branding and Account Access Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Perps Rider safe branding cleanup and reload the app after signed-in access redemption.

**Architecture:** Keep compatibility identifiers stable while replacing active product-brand strings. At the signed-in access-wall boundary, navigate only after redemption has persisted and before stale scene continuations execute.

**Tech Stack:** TypeScript, Vitest, Capacitor, Android Gradle, ADB

## Global Constraints

- Preserve `xyz.redline.game`, legacy local-storage keys, Railway URLs, and the `redline3d/` folder.
- Keep automotive redline terminology where it is not product branding.
- Do not reload guest access or accounts that already bypass the access wall.
- Commit each independently reviewable change.

---

### Task 1: Active Branding Cleanup

**Files:**
- Modify: `server/src/auth/wallet-binding.ts`
- Modify: `server/src/auth/wallet-binding.test.ts`
- Modify: `redline3d/package.json`
- Modify: `redline3d/package-lock.json`
- Modify: `redline3d/src/main.ts`
- Modify: `redline3d/scripts/build-apk.sh`
- Modify: `redline3d/BUILD_APK.md`

**Interfaces:**
- Produces: active brand string `Perps Rider`
- Preserves: all compatibility identifiers listed in Global Constraints

- [ ] **Step 1: Update the wallet-signing test to expect `Perps Rider wallet binding`**
- [ ] **Step 2: Run the focused test and verify it fails on the former brand string**
- [ ] **Step 3: Replace active branding in wallet text, package metadata, runtime logs, and build documentation**
- [ ] **Step 4: Run focused server and client checks**
- [ ] **Step 5: Commit as `chore: finish Perps Rider branding`**

### Task 2: Reload After Account Access

**Files:**
- Modify: `redline3d/src/core/access-code.test.ts`
- Modify: `redline3d/src/main.ts`

**Interfaces:**
- Consumes: `createAccessWall(...).onUnlocked`
- Produces: `location.reload()` after successful signed-in redemption

- [ ] **Step 1: Add a source-wiring regression test for account reload and guest non-reload**
- [ ] **Step 2: Run the focused test and verify it fails**
- [ ] **Step 3: Change only the signed-in wall callback to reload**
- [ ] **Step 4: Run focused tests and the production client build**
- [ ] **Step 5: Commit as `fix: reload after account access redemption`**

### Task 3: Seeker Delivery

**Files:**
- Produce: `redline3d/android/app/build/outputs/apk/debug/app-debug.apk`

**Interfaces:**
- Consumes: committed web client
- Produces: updated `xyz.redline.game` installation on the connected Seeker

- [ ] **Step 1: Run the complete client test suite**
- [ ] **Step 2: Build and install with `npm run apk:install`**
- [ ] **Step 3: Launch the package and verify no fatal Android exception**

